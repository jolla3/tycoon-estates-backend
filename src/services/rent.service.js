// src/services/rent.service.js
//
// Generalized billing charges (RENT | WATER | ELECTRICITY | OTHER) stored
// on the existing RentCharge model via chargeType. Integer cents only.

import { House } from '../models/House.js';
import { Estate } from '../models/Estate.js';
import { RentCharge } from '../models/RentCharge.js';
import { HouseBillingConfig } from '../models/HouseBillingConfig.js';
import { dateUtil } from '../utils/date.js';
import { money } from '../utils/money.js';
import { estateFilterClause } from '../utils/estateFilter.js';
import { audit } from './audit.service.js';

const DEFAULT_CHARGE_TYPES = ['RENT', 'WATER', 'ELECTRICITY', 'OTHER'];

function resolveDueDay(house, estate, configDueDay) {
  if (configDueDay != null) return configDueDay;
  if (house?.dueDay != null) return house.dueDay;
  if (estate?.defaultDueDay != null) return estate.defaultDueDay;
  return 5;
}

/**
 * Active billing lines for a house. If no HouseBillingConfig rows exist,
 * falls back to a single RENT line from house.monthlyRent (backward compatible).
 */
async function billingLinesForHouse(house) {
  const configs = await HouseBillingConfig.find({
    houseId: house._id,
    clientId: house.clientId,
    isActive: true,
  }).lean();

  if (configs.length) {
    return configs.map((c) => ({
      chargeType: c.chargeType,
      description: c.description || c.chargeType,
      amountCents: c.amountCents,
      dueDay: c.dueDay,
    }));
  }

  return [
    {
      chargeType: 'RENT',
      description: 'Rent',
      amountCents: money.toCents(house.monthlyRent),
      dueDay: house.dueDay,
    },
  ];
}

export const rentService = {
  /**
   * Generates period charges for every occupied house under an estate.
   * One RentCharge per (house, period, chargeType). Idempotent via unique index.
   */
  async generateChargesForEstate(clientId, estateId, period = dateUtil.currentPeriod()) {
    const estate = await Estate.findOne({ _id: estateId, clientId }).lean();
    const houses = await House.find({ clientId, estateId, isActive: true, status: 'occupied' });
    let created = 0;

    for (const house of houses) {
      const lines = await billingLinesForHouse(house);
      for (const line of lines) {
        if (!line.amountCents || line.amountCents <= 0) continue;

        // Atomic upsert only (no read-then-create). Unique index:
        // { clientId, houseId, period, chargeType }
        const dueDay = resolveDueDay(house, estate, line.dueDay);
        try {
          const desc = line.description || line.chargeType;
          const result = await RentCharge.findOneAndUpdate(
            {
              clientId,
              houseId: house._id,
              period,
              chargeType: line.chargeType,
              description: desc,
            },
            {
              $setOnInsert: {
                clientId,
                estateId,
                houseId: house._id,
                tenantId: house.tenantId,
                period,
                chargeType: line.chargeType,
                description: desc,
                amountDueCents: line.amountCents,
                amountPaidCents: 0,
                balanceCents: line.amountCents,
                status: 'UNPAID',
                dueDate: dateUtil.dueDateFor(period, dueDay),
              },
            },
            { upsert: true, new: true, rawResult: true }
          );
          // lastErrorObject.updatedExisting === false means insert
          const wasInsert =
            result?.lastErrorObject?.upserted != null ||
            result?.lastErrorObject?.updatedExisting === false;
          if (wasInsert) {
            created += 1;
            // Post CHARGE to Ledger so running balance reflects new billing
            try {
              const { ledgerService } = await import('./ledger.service.js');
              const chargeDoc = result.value || result;
              if (chargeDoc?._id) {
                await ledgerService.postEntry({
                  clientId,
                  estateId,
                  houseId: house._id,
                  tenantId: house.tenantId || null,
                  entryType: 'CHARGE',
                  amountCents: -line.amountCents,
                  referenceType: 'RentCharge',
                  referenceId: chargeDoc._id,
                  description: `${line.chargeType} ${period}`,
                  period,
                });
              }
            } catch {
              // Unique index / race: billing row remains source for billed amount
            }
          }
        } catch (err) {
          // Any duplicate-key (current or legacy unique index) is idempotent success.
          if (err?.code === 11000 || err?.codeName === 'DuplicateKey') continue;
          throw err;
        }
      }
    }
    if (created > 0) {
      await audit({
        clientId,
        estateId,
        action: 'BILL_GENERATED',
        resource: 'RentCharge',
        description: `Generated ${created} charges for period ${period}`,
        metadata: { created, period },
      });
    }
    return { created, period };
  },

  /**
   * Ensures charges exist for a house in a period (all configured types).
   * Used by reconciliation before allocation.
   */
  async ensureChargesForHouse(clientId, house, tenant, period, { session } = {}) {
    const estate = await Estate.findById(house.estateId).session(session || null).lean();
    const lines = await billingLinesForHouse(house);
    const charges = [];

    for (const line of lines) {
      if (!line.amountCents || line.amountCents <= 0) continue;

      let charge = await RentCharge.findOne({
        clientId,
        houseId: house._id,
        period,
        chargeType: line.chargeType,
      }).session(session || null);

      if (!charge) {
        const dueDay = resolveDueDay(house, estate, line.dueDay);
        try {
          const created = await RentCharge.create(
            [
              {
                clientId,
                estateId: house.estateId,
                houseId: house._id,
                tenantId: tenant?._id ?? house.tenantId,
                period,
                chargeType: line.chargeType,
                description: line.description,
                amountDueCents: line.amountCents,
                amountPaidCents: 0,
                balanceCents: line.amountCents,
                status: 'UNPAID',
                dueDate: dateUtil.dueDateFor(period, dueDay),
              },
            ],
            { session }
          );
          charge = created[0];
          try {
            const { ledgerService } = await import('./ledger.service.js');
            await ledgerService.postEntry(
              {
                clientId,
                estateId: house.estateId,
                houseId: house._id,
                tenantId: tenant?._id ?? house.tenantId ?? null,
                entryType: 'CHARGE',
                amountCents: -line.amountCents,
                referenceType: 'RentCharge',
                referenceId: charge._id,
                description: `${line.chargeType} ${period}`,
                period,
              },
              { session }
            );
          } catch {
            // idempotent / race safe
          }
        } catch (err) {
          if (err?.code !== 11000) throw err;
          charge = await RentCharge.findOne({
            clientId,
            houseId: house._id,
            period,
            chargeType: line.chargeType,
          }).session(session || null);
        }
      }
      charges.push(charge);
    }

    // Backward-compat: if somehow no lines, create rent-only
    if (!charges.length) {
      const charge = await this.getOrCreateChargeForHouse(clientId, house, tenant, period, { session });
      charges.push(charge);
    }

    return charges;
  },

  /** @deprecated Prefer ensureChargesForHouse — kept for call sites that expect a single charge. */
  async getOrCreateChargeForHouse(clientId, house, tenant, period, { session } = {}) {
    let charge = await RentCharge.findOne({
      clientId,
      houseId: house._id,
      period,
      chargeType: 'RENT',
    }).session(session || null);

    if (!charge) {
      // Try any charge for period (legacy docs without chargeType may match via default)
      charge = await RentCharge.findOne({ clientId, houseId: house._id, period }).session(session || null);
    }

    if (!charge) {
      const estate = await Estate.findById(house.estateId).session(session || null).lean();
      const dueDay = resolveDueDay(house, estate, null);
      const amountDueCents = money.toCents(house.monthlyRent);
      try {
        const created = await RentCharge.create(
          [
            {
              clientId,
              estateId: house.estateId,
              houseId: house._id,
              tenantId: tenant?._id,
              period,
              chargeType: 'RENT',
              description: 'Rent',
              amountDueCents,
              amountPaidCents: 0,
              balanceCents: amountDueCents,
              status: 'UNPAID',
              dueDate: dateUtil.dueDateFor(period, dueDay),
            },
          ],
          { session }
        );
        charge = created[0];
      } catch (err) {
        if (err?.code !== 11000) throw err;
        charge = await RentCharge.findOne({
          clientId,
          houseId: house._id,
          period,
          chargeType: 'RENT',
        }).session(session || null);
      }
    }
    return charge;
  },

  /** All outstanding charges for a house (any period), for allocation / arrears. */
  async outstandingChargesForHouse(clientId, houseId, { session } = {}) {
    return RentCharge.find({
      clientId,
      houseId,
      status: { $in: ['UNPAID', 'PARTIAL'] },
    })
      .session(session || null)
      .sort({ period: 1, chargeType: 1 });
  },

  /**
   * Previous-period arrears for a house (balances before `period`).
   * Returns total cents and per-charge-type breakdown.
   */
  async previousArrears(clientId, houseId, period) {
    const charges = await RentCharge.find({
      clientId,
      houseId,
      period: { $lt: period },
      status: { $in: ['UNPAID', 'PARTIAL'] },
    }).lean();

    const byType = {};
    let totalCents = 0;
    for (const c of charges) {
      const t = c.chargeType || 'RENT';
      byType[t] = (byType[t] || 0) + c.balanceCents;
      totalCents += c.balanceCents;
    }
    return { totalCents, byType, charges };
  },


  /**
   * Generate charges for all active estates under a client (optional single estate).
   * Respects estateFilter for restricted STAFF. Idempotent per unique index.
   */
  async generateForClient(clientId, { estateId = null, period = null, estateFilter = null } = {}) {
    const p = period || dateUtil.currentPeriod();
    const estateQuery = {
      clientId,
      isActive: true,
      ...estateFilterClause(estateFilter),
    };
    if (estateId) estateQuery._id = estateId;

    const estates = await Estate.find(estateQuery).lean();
    let created = 0;
    const results = [];
    for (const estate of estates) {
      const r = await this.generateChargesForEstate(clientId, estate._id, p);
      created += r.created || 0;
      results.push({ estateId: estate._id, name: estate.name, created: r.created, period: r.period });
    }
    return { period: p, created, estates: results };
  },

  /**
   * House billing account: config + charges + payments for workspace UI.
   * Billed/paid-per-charge come from RentCharge (billing records).
   * Account outstanding comes from Ledger (financial source of truth).
   */
  async houseAccount(clientId, houseId, estateFilter = null) {
    const house = await House.findOne({
      _id: houseId,
      clientId,
      ...estateFilterClause(estateFilter),
    }).lean();
    if (!house) {
      const { Errors } = await import('../utils/errors.js');
      throw Errors.HouseNotFound();
    }
    const period = dateUtil.currentPeriod();
    const [configs, charges, estate] = await Promise.all([
      HouseBillingConfig.find({ clientId, houseId }).lean(),
      RentCharge.find({ clientId, houseId }).sort({ period: -1, chargeType: 1 }).lean(),
      Estate.findById(house.estateId).lean(),
    ]);

    const { Payment } = await import('../models/Payment.js');
    const { ledgerService } = await import('./ledger.service.js');
    const payments = await Payment.find({ clientId, houseId, status: 'CONFIRMED' })
      .sort({ paymentDate: -1 })
      .limit(50)
      .lean();

    let billedCents = 0;
    let paidFromChargesCents = 0;
    let overdueCents = 0;
    const today = dateUtil.now();
    const currentCharges = [];
    const byPeriod = new Map();

    for (const c of charges) {
      billedCents += c.amountDueCents || 0;
      paidFromChargesCents += c.amountPaidCents || 0;
      const bal = Math.max(c.balanceCents || 0, 0);
      if (bal > 0 && c.dueDate && new Date(c.dueDate) < new Date(today.toDate ? today.toDate() : today)) {
        overdueCents += bal;
      }

      if (c.period === period) currentCharges.push(c);

      const row = byPeriod.get(c.period) || {
        period: c.period,
        billedCents: 0,
        paidCents: 0,
        outstandingCents: 0,
        status: 'PAID',
        charges: [],
      };
      row.billedCents += c.amountDueCents || 0;
      row.paidCents += c.amountPaidCents || 0;
      row.outstandingCents += bal;
      row.charges.push({
        chargeType: c.chargeType,
        amountDueCents: c.amountDueCents,
        amountPaidCents: c.amountPaidCents,
        balanceCents: c.balanceCents,
        status: c.status,
        dueDate: c.dueDate,
      });
      if (c.status === 'UNPAID' || row.status === 'UNPAID') {
        row.status =
          c.status === 'PARTIAL' && row.status === 'PAID'
            ? 'PARTIAL'
            : c.status === 'UNPAID'
              ? 'UNPAID'
              : row.status;
      } else if (c.status === 'PARTIAL') row.status = 'PARTIAL';
      byPeriod.set(c.period, row);
    }

    const ledgerBal = await ledgerService.balanceForHouse(clientId, houseId);
    const paidFromLedger = await ledgerService.totalPaymentsReceived(clientId, { houseId });
    const paidCents = paidFromLedger > 0 ? paidFromLedger : paidFromChargesCents;
    const outstandingCents = Math.max(ledgerBal.balanceCents || 0, 0);
    const ledgerHistory = await ledgerService.historyForHouse(clientId, houseId, { limit: 50 });

    return {
      house: {
        _id: house._id,
        houseNumber: house.houseNumber,
        estateId: house.estateId,
        status: house.status,
        monthlyRent: house.monthlyRent,
        dueDay: house.dueDay,
      },
      estate: estate ? { _id: estate._id, name: estate.name } : null,
      period,
      billingConfigs: configs,
      currentCharges,
      payments,
      ledger: ledgerHistory,
      totals: {
        billedCents,
        paidCents,
        outstandingCents,
        overdueCents,
        balanceSource: ledgerBal.source,
      },
      monthly: [...byPeriod.values()].sort((a, b) => (a.period < b.period ? 1 : -1)),
    };
  },

  unpaidHouseholds: (clientId, estateFilter, period = dateUtil.currentPeriod()) =>
    RentCharge.find({
      clientId,
      ...estateFilterClause(estateFilter),
      period,
      status: { $in: ['UNPAID', 'PARTIAL'] },
    })
      .populate('houseId')
      .populate('tenantId'),

  async summary(clientId, estateFilter, period = dateUtil.currentPeriod()) {
    const filter = { clientId, period, ...estateFilterClause(estateFilter) };
    const charges = await RentCharge.find(filter);
    const summary = {
      totalHouseholds: new Set(charges.map((c) => String(c.houseId))).size,
      paid: 0,
      partial: 0,
      unpaid: 0,
      expectedCents: 0,
      collectedCents: 0,
      byChargeType: {},
    };

    const houseStatus = new Map();
    for (const c of charges) {
      const type = c.chargeType || 'RENT';
      if (!summary.byChargeType[type]) {
        summary.byChargeType[type] = { billedCents: 0, paidCents: 0, outstandingCents: 0 };
      }
      summary.byChargeType[type].billedCents += c.amountDueCents;
      summary.byChargeType[type].paidCents += c.amountPaidCents;
      summary.byChargeType[type].outstandingCents += Math.max(c.balanceCents, 0);

      summary.expectedCents += c.amountDueCents;
      summary.collectedCents += c.amountPaidCents;

      const hid = String(c.houseId);
      const prev = houseStatus.get(hid) || 'PAID';
      if (c.status === 'UNPAID' || prev === 'UNPAID') houseStatus.set(hid, c.status === 'PARTIAL' && prev === 'PAID' ? 'PARTIAL' : c.status === 'UNPAID' ? 'UNPAID' : prev);
      else if (c.status === 'PARTIAL') houseStatus.set(hid, 'PARTIAL');
      else if (!houseStatus.has(hid)) houseStatus.set(hid, c.status);
    }

    for (const st of houseStatus.values()) {
      if (st === 'PAID' || st === 'OVERPAID') summary.paid += 1;
      else if (st === 'PARTIAL') summary.partial += 1;
      else summary.unpaid += 1;
    }
    summary.outstandingCents = summary.expectedCents - summary.collectedCents;
    return summary;
  },
};
