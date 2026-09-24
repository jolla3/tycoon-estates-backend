// src/services/report.service.js
import { RentCharge } from '../models/RentCharge.js';
import { BankTransaction } from '../models/BankTransaction.js';
import { Payment } from '../models/Payment.js';
import { SmsMessage } from '../models/SmsMessage.js';
import { rentService } from './rent.service.js';
import { dateUtil } from '../utils/date.js';
import { estateFilterClause } from '../utils/estateFilter.js';
import { House } from '../models/House.js';
import { Estate } from '../models/Estate.js';
import { Tenant } from '../models/Tenant.js';
import { HouseType } from '../models/HouseType.js';

export const reportService = {
  monthly: (clientId, estateFilter, period = dateUtil.currentPeriod()) => rentService.summary(clientId, estateFilter, period),

  /**
   * Richer dashboard payload — the frontend needs actual structured data
   * to render a dashboard, not just the bare rent summary (which is what
   * this returned before). Houses/rent/status come from one RentCharge
   * pass reused via rentService.summary(); bank/sms are separate,
   * lightweight aggregates for the current period.
   */
  async dashboard(clientId, estateFilter, period = dateUtil.currentPeriod()) {
    const scope = { clientId, ...estateFilterClause(estateFilter) };

    const [rent, houses, bank, sms, estates, tenants, types, recentPayments, unmatchedCount, unclassifiedCount, openCharges] =
      await Promise.all([
        rentService.summary(clientId, estateFilter, period),
        House.find({ ...scope, isActive: true }).select('status estateId houseTypeId houseNumber monthlyRent').lean(),
        this.bankTransactions(clientId, estateFilter, period),
        this.sms(clientId, estateFilter),
        Estate.find({ ...scope, isActive: true }).select('name').lean(),
        Tenant.find({ ...scope, status: 'active' }).select('houseId estateId name').lean(),
        HouseType.find({ clientId, isActive: true }).select('name').lean(),
        Payment.find({ ...scope, status: 'CONFIRMED' }).sort({ paymentDate: -1 }).limit(8).lean(),
        BankTransaction.countDocuments({ ...scope, matchStatus: 'UNMATCHED' }),
        House.countDocuments({ ...scope, isActive: true, $or: [{ houseTypeId: null }, { houseTypeId: { $exists: false } }] }),
        RentCharge.find({
          ...scope,
          status: { $in: ['UNPAID', 'PARTIAL'] },
        })
          .select('tenantId houseId balanceCents period')
          .lean(),
      ]);

    const occupied = houses.filter((h) => h.status === 'occupied').length;
    const vacant = houses.filter((h) => h.status === 'vacant').length;
    const houseTotal = houses.length;
    const occupancyRatePercent =
      houseTotal > 0 ? Math.round((occupied / houseTotal) * 1000) / 10 : null;
    const billed = rent.expectedCents || 0;
    const collected = rent.collectedCents || 0;
    const collectionRatePercent =
      billed > 0 ? Math.round((collected / billed) * 1000) / 10 : null;

    // Outstanding tenants (charge-level, not Ledger account balance)
    const tenantOut = new Map();
    for (const c of openCharges) {
      const tid = c.tenantId ? String(c.tenantId) : null;
      if (!tid) continue;
      tenantOut.set(tid, (tenantOut.get(tid) || 0) + Math.max(c.balanceCents || 0, 0));
    }
    const tenantsOutstanding = [...tenantOut.values()].filter((v) => v > 0).length;

    // byEstate
    const estateName = new Map(estates.map((e) => [String(e._id), e.name]));
    const byEstateMap = new Map();
    for (const e of estates) {
      byEstateMap.set(String(e._id), {
        estateId: e._id,
        name: e.name,
        houses: 0,
        occupied: 0,
        vacant: 0,
        tenants: 0,
        billedCents: 0,
        collectedCents: 0,
      });
    }
    for (const h of houses) {
      const k = String(h.estateId);
      if (!byEstateMap.has(k)) {
        byEstateMap.set(k, {
          estateId: h.estateId,
          name: estateName.get(k) || 'Estate',
          houses: 0,
          occupied: 0,
          vacant: 0,
          tenants: 0,
          billedCents: 0,
          collectedCents: 0,
        });
      }
      const row = byEstateMap.get(k);
      row.houses += 1;
      if (h.status === 'occupied') row.occupied += 1;
      else row.vacant += 1;
    }
    for (const t of tenants) {
      const k = String(t.estateId);
      if (byEstateMap.has(k)) byEstateMap.get(k).tenants += 1;
    }

    // Period charges by estate / houseType for billed metrics
    const periodCharges = await RentCharge.find({
      clientId,
      period,
      ...estateFilterClause(estateFilter),
    })
      .select('estateId houseId amountDueCents amountPaidCents')
      .lean();
    const houseTypeByHouse = new Map(houses.map((h) => [String(h._id), h.houseTypeId ? String(h.houseTypeId) : null]));
    const typeName = new Map(types.map((t) => [String(t._id), t.name]));
    const byTypeMap = new Map();
    for (const t of types) {
      byTypeMap.set(String(t._id), {
        houseTypeId: t._id,
        name: t.name,
        houses: 0,
        occupied: 0,
        vacant: 0,
        billedCents: 0,
        collectedCents: 0,
      });
    }
    byTypeMap.set('__none__', {
      houseTypeId: null,
      name: 'Unclassified',
      houses: 0,
      occupied: 0,
      vacant: 0,
      billedCents: 0,
      collectedCents: 0,
    });
    for (const h of houses) {
      const k = h.houseTypeId ? String(h.houseTypeId) : '__none__';
      if (!byTypeMap.has(k)) {
        byTypeMap.set(k, {
          houseTypeId: h.houseTypeId,
          name: typeName.get(k) || 'Unknown',
          houses: 0,
          occupied: 0,
          vacant: 0,
          billedCents: 0,
          collectedCents: 0,
        });
      }
      const row = byTypeMap.get(k);
      row.houses += 1;
      if (h.status === 'occupied') row.occupied += 1;
      else row.vacant += 1;
    }
    for (const c of periodCharges) {
      const ek = String(c.estateId);
      if (byEstateMap.has(ek)) {
        byEstateMap.get(ek).billedCents += c.amountDueCents || 0;
        byEstateMap.get(ek).collectedCents += c.amountPaidCents || 0;
      }
      const tk = houseTypeByHouse.get(String(c.houseId)) || '__none__';
      if (byTypeMap.has(tk)) {
        byTypeMap.get(tk).billedCents += c.amountDueCents || 0;
        byTypeMap.get(tk).collectedCents += c.amountPaidCents || 0;
      }
    }

    const alerts = [];
    if (tenantsOutstanding > 0) {
      alerts.push({
        kind: 'arrears',
        count: tenantsOutstanding,
        label: `${tenantsOutstanding} tenant(s) with open charge balances`,
        href: '/reports',
      });
    }
    if (unmatchedCount > 0) {
      alerts.push({
        kind: 'unmatched',
        count: unmatchedCount,
        label: `${unmatchedCount} unmatched bank transaction(s)`,
        href: '/transactions/unmatched',
      });
    }
    if (vacant > 0) {
      alerts.push({
        kind: 'vacant',
        count: vacant,
        label: `${vacant} vacant house(s)`,
        href: '/houses',
      });
    }
    if (unclassifiedCount > 0) {
      alerts.push({
        kind: 'unclassified',
        count: unclassifiedCount,
        label: `${unclassifiedCount} house(s) without HouseType`,
        href: '/houses',
      });
    }
    if (sms.failed > 0) {
      alerts.push({
        kind: 'sms_failed',
        count: sms.failed,
        label: `${sms.failed} failed SMS`,
        href: '/sms',
      });
    }

    return {
      period,
      portfolio: {
        estateCount: estates.length,
        houseCount: houseTotal,
        occupiedHouses: occupied,
        vacantHouses: vacant,
        occupancyRatePercent,
        tenantCount: tenants.length,
        houseTypeCount: types.length,
        unclassifiedHouses: unclassifiedCount,
      },
      houses: { total: houseTotal, occupied, vacant },
      rent: {
        expectedCents: billed,
        collectedCents: collected,
        outstandingCents: rent.outstandingCents,
        collectionRatePercent,
      },
      status: { paid: rent.paid, partial: rent.partial, unpaid: rent.unpaid },
      bank: {
        creditsCents: bank.totalCreditsCents,
        debitsCents: bank.totalDebitsCents,
        matched: bank.matched,
        unmatched: bank.unmatched,
        unmatchedAllTime: unmatchedCount,
      },
      sms: { sent: sms.sent, failed: sms.failed, pending: sms.pending, unknown: sms.unknown },
      byEstate: [...byEstateMap.values()].sort((a, b) => a.name.localeCompare(b.name)),
      byHouseType: [...byTypeMap.values()]
        .filter((r) => r.houses > 0 || r.billedCents > 0)
        .sort((a, b) => a.name.localeCompare(b.name)),
      alerts,
      recentPayments: recentPayments.map((p) => ({
        _id: p._id,
        amountCents: p.amountCents,
        paymentDate: p.paymentDate,
        houseId: p.houseId,
        tenantId: p.tenantId,
        paymentReference: p.paymentReference,
        period: p.period,
      })),
      tenantsWithOutstandingCount: tenantsOutstanding,
    };
  },


  /**
   * Management report bundle for the Reports centre.
   * Charge metrics from RentCharge; bank/sms from their collections.
   */
  async managementSummary(clientId, estateFilter, period = dateUtil.currentPeriod()) {
    const dash = await this.dashboard(clientId, estateFilter, period);
    const [arrears, billedVsPaid] = await Promise.all([
      this.arrears(clientId, estateFilter, period),
      this.billedVsPaid(clientId, estateFilter, period),
    ]);
    return {
      ...dash,
      arrears,
      billedVsPaid,
    };
  },

  async arrears(clientId, estateFilter, period = dateUtil.currentPeriod()) {
    // Open balances across periods (true arrears), not only the selected period.
    // `period` is returned for context; filter is intentionally not limited to it.
    const filter = {
      clientId,
      status: { $in: ['UNPAID', 'PARTIAL'] },
      ...estateFilterClause(estateFilter),
    };

    const charges = await RentCharge.find(filter)
      .populate('houseId', 'houseNumber estateId')
      .populate('tenantId', 'name phone')
      .sort({ period: 1, houseId: 1 })
      .lean();

    return charges.map((c) => ({
      estateId: c.estateId,
      houseId: c.houseId?._id || c.houseId,
      house: c.houseId?.houseNumber || null,
      tenantId: c.tenantId?._id || c.tenantId,
      tenant: c.tenantId?.name || null,
      period: c.period,
      chargeType: c.chargeType || 'RENT',
      dueCents: c.amountDueCents,
      paidCents: c.amountPaidCents,
      balanceCents: c.balanceCents,
      status: c.status,
      dueDate: c.dueDate,
      referencePeriod: period,
    }));
  },

  payments: (clientId, estateFilter, { limit = 50 } = {}) =>
    Payment.find({ clientId, ...estateFilterClause(estateFilter) }).sort({ paymentDate: -1 }).limit(limit),

  async bankTransactions(clientId, estateFilter, period = dateUtil.currentPeriod()) {
    const start = dateUtil.startOfMonth(period).toDate();
    const end = dateUtil.endOfMonth(period).toDate();
    const filter = { clientId, transactionDate: { $gte: start, $lte: end }, ...estateFilterClause(estateFilter) };

    const txns = await BankTransaction.find(filter);

    const out = { totalCreditsCents: 0, totalDebitsCents: 0, matched: 0, unmatched: 0 };
    for (const t of txns) {
      if (t.eventType === 'CREDIT') out.totalCreditsCents += t.amountCents;
      else out.totalDebitsCents += t.amountCents;
      if (t.matchStatus === 'MATCHED') out.matched += 1;
      else out.unmatched += 1;
    }
    return out;
  },

  async sms(clientId, estateFilter) {
    const messages = await SmsMessage.find({ clientId, ...estateFilterClause(estateFilter) });
    const out = { sent: 0, failed: 0, pending: 0, unknown: 0 };
    for (const m of messages) {
      if (m.status === 'sent') out.sent += 1;
      else if (m.status === 'failed') out.failed += 1;
      else if (m.status === 'unknown') out.unknown += 1;
      else out.pending += 1;
    }
    return out;
  },

  /**
   * Billed / Paid / Outstanding by charge type for a period,
   * plus previous-period arrears totals.
   */
  async billedVsPaid(clientId, estateFilter, period) {
    const p = period || dateUtil.currentPeriod();
    const filter = { clientId, period: p, ...estateFilterClause(estateFilter) };
    const charges = await RentCharge.find(filter).lean();

    const byChargeType = {};
    let billedCents = 0;
    let paidCents = 0;
    let outstandingCents = 0;

    for (const c of charges) {
      const type = c.chargeType || 'RENT';
      if (!byChargeType[type]) {
        byChargeType[type] = { billedCents: 0, paidCents: 0, balanceCents: 0 };
      }
      byChargeType[type].billedCents += c.amountDueCents;
      byChargeType[type].paidCents += c.amountPaidCents;
      byChargeType[type].balanceCents += Math.max(c.balanceCents, 0);
      billedCents += c.amountDueCents;
      paidCents += c.amountPaidCents;
      outstandingCents += Math.max(c.balanceCents, 0);
    }

    // Previous arrears: balances on charges before this period
    const arrearsFilter = {
      clientId,
      period: { $lt: p },
      status: { $in: ['UNPAID', 'PARTIAL'] },
      ...estateFilterClause(estateFilter),
    };
    const prior = await RentCharge.find(arrearsFilter).lean();
    let previousArrearsCents = 0;
    const previousArrearsByType = {};
    for (const c of prior) {
      const type = c.chargeType || 'RENT';
      previousArrearsByType[type] = (previousArrearsByType[type] || 0) + Math.max(c.balanceCents, 0);
      previousArrearsCents += Math.max(c.balanceCents, 0);
    }

    return {
      period: p,
      byChargeType,
      total: { billedCents, paidCents, balanceCents: outstandingCents },
      previousArrearsCents,
      previousArrearsByType,
      totalOutstandingIncludingArrearsCents: outstandingCents + previousArrearsCents,
    };
  },
};
