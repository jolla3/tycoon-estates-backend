// src/services/tenant.service.js
import { Tenant } from '../models/Tenant.js';
import { House } from '../models/House.js';
import { Estate } from '../models/Estate.js';
import { RentCharge } from '../models/RentCharge.js';
import { SmsMessage } from '../models/SmsMessage.js';
import { AuditLog } from '../models/AuditLog.js';
import { Payment } from '../models/Payment.js';
import { ManualReceipt } from '../models/ManualReceipt.js';
import { Tenancy } from '../models/Tenancy.js';
import { TenantCreditMovement } from '../models/TenantCreditMovement.js';
import { creditBalanceCents } from './tenantCredit.service.js';
import { Errors } from '../utils/errors.js';
import { estateFilterClause } from '../utils/estateFilter.js';
import { dateUtil } from '../utils/date.js';
import { ledgerService } from './ledger.service.js';
import { tenancyService } from './tenancy.service.js';
import mongoose from 'mongoose';
import { supportsMongoTransactions } from '../config/database.js';


/**
 * Four distinct concepts (never interchangeable):
 *  A receivedCents        gross money received (ManualReceipt gross + non-child M-PESA/BANK/legacy
 *                         Payments + M-PESA surplus). Existing-credit applications are NOT received.
 *  B appliedToRentCents   amount allocated to this tenant's rent charges (from receipts AND credit).
 *  C creditCents          available credit = sum of immutable TenantCreditMovement rows.
 *  D outstandingCents     unpaid balance of this tenant's open charges.
 * Never derived by summing Payments for credit; ManualReceipt is never added to its own children.
 */
async function buildAccount(clientId, tenant, charges, tenancyIds) {
  const scope = { clientId, estateId: tenant.estateId, tenantId: tenant._id };
  const [receipts, otherPayments, movements, creditCents] = await Promise.all([
    ManualReceipt.find(scope).sort({ paymentDate: -1, _id: -1 }).lean(),
    Payment.find({
      ...scope, status: 'CONFIRMED',
      $or: [
        { origin: { $in: ['MPESA', 'BANK'] } },
        { origin: 'MANUAL', manualReceiptId: null },
        { origin: 'MANUAL', manualReceiptId: { $exists: false } },
      ],
    }).sort({ paymentDate: -1, _id: -1 }).lean(),
    TenantCreditMovement.find(scope).sort({ createdAt: -1, _id: -1 }).lean(),
    creditBalanceCents(scope),
  ]);

  const houseIds = [...new Set([
    ...receipts.map((r) => r.houseId), ...otherPayments.map((p) => p.houseId),
  ].filter(Boolean).map(String))];
  const houses = await House.find({ _id: { $in: houseIds }, clientId }).select('houseNumber').lean();
  const houseNo = new Map(houses.map((h) => [String(h._id), h.houseNumber]));

  const history = [];
  for (const r of receipts) {
    history.push({
      kind: 'manual_receipt',
      id: String(r._id),
      origin: 'MANUAL',
      status: r.status,
      paymentDate: r.paymentDate,
      paymentDateLocal: r.paymentDateLocal,
      reference: r.paymentReference || null,
      tenderMethod: r.tenderMethod,
      houseId: String(r.houseId),
      houseNumber: houseNo.get(String(r.houseId)) ?? null,
      tenancyId: String(r.occupancyTenancyId),
      grossCents: r.amountCents,
      appliedToRentCents: r.receiptAppliedCents || 0,
      appliedFromCreditCents: r.creditAppliedCents || 0,
      newCreditCents: r.newCreditCents || 0,
    });
  }
  for (const p of otherPayments) {
    history.push({
      kind: 'payment',
      id: String(p._id),
      origin: p.origin,
      status: p.status,
      paymentDate: p.paymentDate,
      paymentDateLocal: null,
      reference: p.paymentReference || null,
      tenderMethod: p.tenderMethod || null,
      houseId: p.houseId ? String(p.houseId) : null,
      houseNumber: houseNo.get(String(p.houseId)) ?? null,
      tenancyId: p.tenancyId ? String(p.tenancyId) : null,
      grossCents: p.amountCents,
      appliedToRentCents: p.amountCents,
      appliedFromCreditCents: 0,
      newCreditCents: 0,
    });
  }
  // M-PESA surplus is money received that carries no allocation Payment; manual surplus is
  // already inside its ManualReceipt, so only movements without a manualReceiptId count.
  const mpesaSurplus = movements.filter(
    (m) => m.movementType === 'RECEIPT_SURPLUS' && !m.manualReceiptId
  );
  for (const m of mpesaSurplus) {
    history.push({
      kind: 'mpesa_surplus', id: String(m._id), origin: 'MPESA', status: 'CONFIRMED',
      paymentDate: m.createdAt, paymentDateLocal: null, reference: null, tenderMethod: 'MPESA',
      houseId: null, houseNumber: null, tenancyId: m.tenancyId ? String(m.tenancyId) : null,
      grossCents: m.amountCents, appliedToRentCents: 0, appliedFromCreditCents: 0,
      newCreditCents: m.amountCents,
    });
  }
  history.sort((a, b) => new Date(b.paymentDate) - new Date(a.paymentDate));

  const sum = (arr, f) => arr.reduce((t, x) => t + (f(x) || 0), 0);
  const receivedCents = sum(history, (h) => h.grossCents);
  const own = charges.filter((c) => tenancyIds.some((id) => String(id) === String(c.tenancyId)) || String(c.tenantId) === String(tenant._id));
  const billedCents = sum(own, (c) => c.amountDueCents);
  const appliedToRentCents = sum(own, (c) => c.amountPaidCents);
  const outstandingCents = sum(own, (c) => Math.max(c.balanceCents || 0, 0));
  const appliedFromCreditCents = -sum(movements.filter((m) => m.movementType === 'CREDIT_APPLIED'), (m) => m.amountCents);

  return {
    paymentHistory: history,
    account: {
      receivedCents,
      billedCents,
      appliedToRentCents,
      appliedFromCreditCents,
      creditCents,
      outstandingCents,
      netCents: creditCents - outstandingCents,
    },
  };
}

export const tenantService = {
  async create(clientId, data, actorUserId = null) {
    const house = await House.findOne({ _id: data.houseId, clientId });
    if (!house) throw Errors.HouseNotFound();
    if (supportsMongoTransactions() === false) {
      throw Errors.ServiceUnavailable('MongoDB transactions required for tenant create');
    }
    const session = await mongoose.startSession();
    try {
      let tenant;
      await session.withTransaction(async () => {
        const [created] = await Tenant.create(
          [{ ...data, clientId, estateId: house.estateId, status: 'active' }],
          { session }
        );
        tenant = created;
        await tenancyService.open({
          clientId, estateId: house.estateId, houseId: house._id,
          tenantId: tenant._id, startAt: data.moveInDate || new Date(), actorUserId,
        }, { session });
      });
      return tenant;
    } finally {
      session.endSession();
    }
  },

  list: (clientId, estateFilter) =>
    Tenant.find({ clientId, ...estateFilterClause(estateFilter) }).sort({ createdAt: -1 }),

  async get(clientId, tenantId, estateFilter = null) {
    const tenant = await Tenant.findOne({
      _id: tenantId,
      clientId,
      ...estateFilterClause(estateFilter),
    }).lean();
    if (!tenant) throw Errors.TenantNotFound();

    const ownTenancies = await Tenancy.find({
      clientId, tenantId: tenant._id, estateId: tenant.estateId, status: { $in: ['ACTIVE', 'CLOSED'] },
    }).select('_id houseId').lean();
    const tenancyIds = ownTenancies.map((t) => t._id);

    const [house, estate, charges, sms, activity, payments] = await Promise.all([
      House.findOne({ _id: tenant.houseId, clientId }).lean(),
      Estate.findOne({ _id: tenant.estateId, clientId }).lean(),
      RentCharge.find({
        clientId,
        // Only this tenant's own obligations (never another occupant of the same house).
        $or: [
          { tenantId: tenant._id },
          { tenancyId: { $in: tenancyIds } },
        ],
      })
        .sort({ period: -1 })
        .lean(),
      SmsMessage.find({ clientId, tenantId: tenant._id }).sort({ createdAt: -1 }).limit(20).lean(),
      AuditLog.find({
        clientId,
        resource: 'Tenant',
        resourceId: tenant._id,
      })
        .sort({ createdAt: -1 })
        .limit(20)
        .lean(),
      Payment.find({ clientId, tenantId: tenant._id, status: 'CONFIRMED' })
        .sort({ paymentDate: -1 })
        .limit(50)
        .lean(),
    ]);

    // Billing metrics from RentCharge; account balance from Ledger (source of truth)
    let billedCents = 0;
    let paidFromChargesCents = 0;
    const byPeriod = new Map();

    for (const c of charges) {
      billedCents += c.amountDueCents || 0;
      paidFromChargesCents += c.amountPaidCents || 0;
      const key = c.period || 'unknown';
      const row = byPeriod.get(key) || {
        period: key,
        billedCents: 0,
        paidCents: 0,
        outstandingCents: 0,
      };
      row.billedCents += c.amountDueCents || 0;
      row.paidCents += c.amountPaidCents || 0;
      row.outstandingCents += Math.max(c.balanceCents || 0, 0);
      byPeriod.set(key, row);
    }

    const monthly = [...byPeriod.values()].sort((a, b) => (a.period < b.period ? 1 : -1));

    const activeTenancy = await tenancyService.getActiveForHouse(clientId, tenant.houseId);
    const ledgerBal = activeTenancy
      ? await ledgerService.balanceForTenancy(clientId, activeTenancy._id)
      : tenant.houseId
        ? await ledgerService.balanceForHouse(clientId, tenant.houseId)
        : await ledgerService.balanceForTenant(clientId, tenant._id, null);
    // Authoritative outstanding = Ledger running balance (amount owed)
    const knownArrearsCents = Number.isSafeInteger(ledgerBal?.knownArrearsCents)
      ? ledgerBal.knownArrearsCents
      : null;
    const outstandingCents = knownArrearsCents;
    // Prefer ledger-reported payments when available; fall back to charge cache
    const paidFromLedger = tenant.houseId
      ? await ledgerService.totalPaymentsReceived(clientId, { houseId: tenant.houseId })
      : await ledgerService.totalPaymentsReceived(clientId, { tenantId: tenant._id });
    // "Paid" = money allocated to this tenant's rent charges. It is NOT money received:
    // see `account` for gross received, credit and outstanding.
    void paidFromLedger;
    const paidCents = paidFromChargesCents;

    const account = await buildAccount(clientId, tenant, charges, tenancyIds);

    return {
      ...tenant,
      house: house
        ? {
            _id: house._id,
            houseNumber: house.houseNumber,
            status: house.status,
            houseTypeId: house.houseTypeId,
          }
        : null,
      estate: estate ? { _id: estate._id, name: estate.name, address: estate.address } : null,
      financials: {
        billedCents,
        paidCents,
        outstandingCents,
        knownArrearsCents,
        historicalCoverage: ledgerBal?.historicalCoverage ?? 'UNVERIFIED',
        verifiedFullObligation: ledgerBal?.verifiedFullObligation === true,
        balanceSource: ledgerBal?.source || 'unavailable',
        overdueCents: charges
          .filter((c) => Math.max(c.balanceCents || 0, 0) > 0 && c.dueDate && new Date(c.dueDate) < new Date())
          .reduce((s, c) => s + Math.max(c.balanceCents || 0, 0), 0),
        oldestUnpaidPeriod: (() => {
          const open = charges
            .filter((c) => Math.max(c.balanceCents || 0, 0) > 0)
            .map((c) => c.period)
            .sort();
          return open[0] || null;
        })(),
        currentPeriod: dateUtil.currentPeriod(),
      },
      account: account.account,
      paymentHistory: account.paymentHistory,
      payments: payments.map((p) => ({
        _id: p._id,
        amountCents: p.amountCents,
        paymentDate: p.paymentDate,
        paymentReference: p.paymentReference,
        period: p.period,
        houseId: p.houseId,
        status: p.status,
      })),
      monthly,
      billingHistory: charges.slice(0, 50).map((c) => ({
        _id: c._id,
        period: c.period,
        chargeType: c.chargeType,
        amountDueCents: c.amountDueCents,
        amountPaidCents: c.amountPaidCents,
        balanceCents: c.balanceCents,
        status: c.status,
      })),
      smsHistory: sms.map((m) => ({
        _id: m._id,
        phoneNumber: m.phoneNumber,
        message: m.message,
        status: m.status,
        type: m.type,
        createdAt: m.createdAt,
        sentAt: m.sentAt,
      })),
      activity,
    };
  },

  async update(clientId, tenantId, updates, estateFilter = null) {
    const tenant = await Tenant.findOneAndUpdate(
      { _id: tenantId, clientId, ...estateFilterClause(estateFilter) },
      updates,
      { new: true }
    );
    if (!tenant) throw Errors.TenantNotFound();

    if (updates.status === 'moved_out') {
      const active = await tenancyService.getActiveForHouse(clientId, tenant.houseId);
      if (active && String(active.tenantId) === String(tenant._id)) {
        await tenancyService.close(clientId, active._id, { reason: 'MOVE_OUT' });
      } else {
        await House.updateOne(
          { _id: tenant.houseId, clientId, ...estateFilterClause(estateFilter) },
          { tenantId: null, status: 'vacant' }
        );
      }
    }
    return tenant;
  },

  async moveToHouse(clientId, tenantId, newHouseId, estateFilter = null, actorUserId = null) {
    await tenancyService.moveToHouse(clientId, tenantId, newHouseId, estateFilter, actorUserId);
    const tenant = await Tenant.findOne({ _id: tenantId, clientId });
    if (!tenant) throw Errors.TenantNotFound();
    return tenant;
  },
};
