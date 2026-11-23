// src/services/tenantCredit.service.js
//
// G3 extension — Tenant-level credit and cross-Tenancy settlement.
// NOT a second accounting engine: every money movement still lands in
// Payment + PaymentAllocation + RentCharge projection + Ledger (G3 models).
// Tenant credit is an immutable movement collection with a derived balance.
//
// All write functions REQUIRE an active MongoDB session (caller owns the
// transaction) and serialize through non-monetary CAS tokens:
//   Tenant.creditRev -> Tenancy.ledgerRev (sorted) -> RentCharge.allocationRev (sorted)

import mongoose from 'mongoose';
import { Tenant } from '../models/Tenant.js';
import { Tenancy } from '../models/Tenancy.js';
import { RentCharge } from '../models/RentCharge.js';
import { Payment } from '../models/Payment.js';
import { PaymentAllocation } from '../models/PaymentAllocation.js';
import { TenantCreditMovement, CREDIT_MOVEMENT_TYPE } from '../models/TenantCreditMovement.js';
import { ledgerService } from './ledger.service.js';
import { planReceiptWithCredit } from '../utils/crossTenancyAllocation.js';
import { statusAfterPayment } from '../utils/allocation.js';
import { requirePositiveSafeCents } from '../utils/moneyInt.js';
import { Errors } from '../utils/errors.js';

const idStr = (v) => String(v);
const sameId = (a, b) => a != null && b != null && String(a) === String(b);

function requireSession(session) {
  if (!session) throw Errors.ServiceUnavailable('Tenant credit operations require a MongoDB transaction');
}

export async function creditBalanceCents({ clientId, estateId, tenantId }, { session } = {}) {
  const rows = await TenantCreditMovement.aggregate([
    { $match: { clientId, estateId, tenantId } },
    { $group: { _id: null, total: { $sum: '$amountCents' } } },
  ]).session(session || null);
  const total = rows[0]?.total || 0;
  if (!Number.isSafeInteger(total) || total < 0) {
    throw Errors.Conflict('Tenant credit balance is invalid (negative or unsafe)');
  }
  return total;
}

/** Non-transactional read of eligible obligations (for account views). */
export async function listObligations({ clientId, estateId, tenantId }, { session } = {}) {
  const tenancies = await Tenancy.find({
    clientId, estateId, tenantId, status: { $in: ['ACTIVE', 'CLOSED'] },
  }).sort({ _id: 1 }).session(session || null);
  const ids = tenancies.map((t) => t._id);
  const charges = ids.length
    ? await RentCharge.find({
      clientId, estateId, tenancyId: { $in: ids },
      status: { $in: ['UNPAID', 'PARTIAL'] }, balanceCents: { $gt: 0 },
    }).sort({ _id: 1 }).session(session || null)
    : [];
  return { tenancies, charges };
}

/**
 * Tenant-wide financial snapshot for the record-payment UI.
 * net = credit - outstanding obligations (positive = credit, negative = arrears).
 */
export async function tenantAccountSnapshot({ clientId, estateId, tenantId }, { session } = {}) {
  const credit = await creditBalanceCents({ clientId, estateId, tenantId }, { session });
  const { charges } = await listObligations({ clientId, estateId, tenantId }, { session });
  let outstanding = 0;
  for (const c of charges) {
    const b = c.balanceCents || 0;
    if (Number.isSafeInteger(b) && b > 0) outstanding += b;
  }
  if (!Number.isSafeInteger(outstanding)) {
    throw Errors.Conflict('Tenant outstanding total is not a safe integer');
  }
  return {
    creditCents: credit,
    outstandingCents: outstanding,
    netCents: credit - outstanding,
  };
}

async function bumpAllocationRev(model, id, scope, session) {
  const r = await model.updateOne({ _id: id, ...scope }, { $inc: { allocationRev: 1 } }, { session });
  if (r.matchedCount !== 1) throw Errors.Conflict(`Allocation write point unavailable for ${model.modelName}`);
}

async function projectCharge(chargeId, scope, session) {
  const rows = await PaymentAllocation.aggregate([
    { $match: { rentChargeId: chargeId } },
    { $group: { _id: null, total: { $sum: '$amountCents' } } },
  ]).session(session);
  const paid = rows[0]?.total || 0;
  const charge = await RentCharge.findOne({ _id: chargeId, ...scope }).session(session);
  if (!charge) throw Errors.Conflict('RentCharge left scope during projection');
  charge.amountPaidCents = paid;
  charge.balanceCents = charge.amountDueCents - paid;
  charge.status = statusAfterPayment(charge.amountDueCents, paid);
  await charge.save({ session });
  return charge;
}

/**
 * Settle a Tenant account inside the caller's transaction.
 *  - existing credit pays the oldest obligations first (CREDIT Payments, SETTLEMENT ledger);
 *  - the receipt (if any) pays the oldest remaining obligations;
 *  - any receipt remainder becomes new Tenant credit.
 * Never allocates beyond a charge balance; never creates charges.
 *
 * receipt shapes (source is mandatory; an unknown/missing source is rejected):
 *   MPESA:
 *     { source:'MPESA', transactionId, amountCents, receiptNumber?, transactionAt? }
 *     A sourceTenancyCheck is required for exact transaction-time attribution.
 *   BANK:
 *     { source:'BANK', bankTransactionId, amountCents, paymentDate? }
 *     A sourceTenancyCheck is required for exact transaction-time attribution.
 *   MANUAL:
 *     { source:'MANUAL', identityKey, amountCents, tenderMethod,
 *       manualReceiptId?, recordedByUserId?, paymentDate? }
 *     External paymentReference is NOT copied onto child Payments.
 *
 * Full-surplus receipts (no allocation slices):
 *   - MPESA: only TenantCreditMovement RECEIPT_SURPLUS (no marker Payment).
 *   - BANK: only BankTransaction envelope + linked RECEIPT_SURPLUS movement.
 *   - MANUAL: same; canonical identity is the caller's ManualReceipt envelope.
 */
export async function settleTenantAccount({
  clientId,
  estateId,
  tenantId,
  receipt = null,
  paymentDate = null,
  session,
  sourceTenancyCheck = null,
}) {
  requireSession(session);

  const source = receipt ? receipt.source : null;

  if (receipt) {
    if (!['MANUAL', 'MPESA', 'BANK'].includes(source)) {
      throw Errors.InvalidRequest('Receipt source must be explicitly MANUAL, MPESA, or BANK');
    }
    requirePositiveSafeCents(receipt.amountCents);
    if (source === 'MPESA' && !receipt.transactionId) {
      throw Errors.InvalidRequest('receipt.transactionId required');
    }
    if (source === 'MANUAL' && !receipt.identityKey) {
      throw Errors.InvalidRequest('receipt.identityKey required for manual receipts');
    }
    if (source === 'BANK' && !receipt.bankTransactionId) {
      throw Errors.InvalidRequest('receipt.bankTransactionId required for Bank receipts');
    }
    if (['BANK', 'MPESA'].includes(source) && (!sourceTenancyCheck?.tenancyId
      || !sourceTenancyCheck?.houseId || !sourceTenancyCheck?.transactionAt)) {
      throw Errors.InvalidRequest('M-PESA/Bank receipts require exact source-tenancy transaction-time validation');
    }
    if (['BANK', 'MPESA'].includes(source)) {
      const receiptDate = receipt.paymentDate || paymentDate || receipt.transactionAt;
      const receiptTime = receiptDate instanceof Date ? receiptDate.getTime() : NaN;
      const sourceTime = new Date(sourceTenancyCheck.transactionAt).getTime();
      if (!Number.isFinite(receiptTime) || !Number.isFinite(sourceTime) || receiptTime !== sourceTime) {
        throw Errors.InvalidRequest('Receipt Payment date must equal its provider transaction timestamp exactly');
      }
      const allowedStatuses = sourceTenancyCheck.allowedStatuses || ['ACTIVE', 'CLOSED'];
      if (!Array.isArray(allowedStatuses) || !allowedStatuses.length
        || allowedStatuses.some((status) => !['ACTIVE', 'CLOSED'].includes(status))) {
        throw Errors.InvalidRequest('Source tenancy allowedStatuses must be a non-empty ACTIVE/CLOSED list');
      }
    }
  }

  // 1. serialization point for this Tenant's credit account
  // Tenant.estateId/houseId are current location pointers and may have moved
  // after a historical Tenancy closed. Lock the Tenant identity by client;
  // all financial reads/writes below remain scoped to the supplied historical
  // { clientId, estateId, tenantId } account and cannot cross estates.
  const lock = await Tenant.findOneAndUpdate(
    { _id: tenantId, clientId },
    { $inc: { creditRev: 1 } },
    { session, new: true }
  );
  if (!lock) throw Errors.Conflict('Tenant not found in Client scope');
  const creditRev = lock.creditRev;

  // 2. lock Tenancies in sorted order, then read obligations
  const { tenancies, charges } = await listObligations({ clientId, estateId, tenantId }, { session });
  for (const t of tenancies) {
    const r = await Tenancy.updateOne(
      { _id: t._id, clientId, estateId, tenantId },
      { $inc: { ledgerRev: 1 } },
      { session }
    );
    if (r.matchedCount !== 1) throw Errors.Conflict('Tenancy left scope');
  }

  // Optional provider-source attribution fence. This is deliberately checked
  // AFTER the shared Tenant.creditRev and sorted Tenancy.ledgerRev locks, so
  // Bank/M-PESA cannot invert the allocator's established lock order.
  if (sourceTenancyCheck) {
    const {
      tenancyId,
      houseId,
      transactionAt,
      allowedStatuses = ['ACTIVE', 'CLOSED'],
    } = sourceTenancyCheck;
    const eventMs = new Date(transactionAt).getTime();
    const source = await Tenancy.findOne({
      _id: tenancyId,
      clientId,
      estateId,
      tenantId,
      status: { $in: allowedStatuses },
    }).session(session).lean();
    const startMs = source ? new Date(source.startAt).getTime() : NaN;
    const endMs = source?.endAt == null ? null : new Date(source.endAt).getTime();
    if (!source || !sameId(source.houseId, houseId)
      || !Number.isFinite(eventMs) || !Number.isFinite(startMs)
      || eventMs < startMs
      || (endMs != null && (!Number.isFinite(endMs) || eventMs >= endMs))) {
      const error = Errors.Conflict('Receipt transaction timestamp or source Tenancy status changed before settlement');
      error.code = 'SOURCE_TENANCY_REQUIRES_REVIEW';
      throw error;
    }
  }

  const byId = new Map(tenancies.map((t) => [idStr(t._id), t]));
  const tenancyStartMs = new Map(tenancies.map((t) => [idStr(t._id), t.startAt]));
  const creditBefore = await creditBalanceCents({ clientId, estateId, tenantId }, { session });

  const plan = planReceiptWithCredit(
    charges,
    { receiptCents: receipt ? receipt.amountCents : 0, creditCents: creditBefore },
    { tenancyStartMs }
  );

  const when = paymentDate
    || (receipt && (receipt.paymentDate || receipt.transactionAt))
    || new Date();
  const created = { receiptPayments: [], creditPayments: [], movements: [], allocations: [] };
  const touchedCharges = new Set();
  const manualReceiptId = source === 'MANUAL' && receipt.manualReceiptId
    ? receipt.manualReceiptId
    : null;

  const post = async ({ slices, origin, keyBase }) => {
    const perTenancy = new Map();
    for (const s of slices) {
      if (!perTenancy.has(s.tenancyId)) perTenancy.set(s.tenancyId, []);
      perTenancy.get(s.tenancyId).push(s);
    }
    const out = [];
    for (const tenancyId of [...perTenancy.keys()].sort()) {
      const tenancy = byId.get(tenancyId);
      if (!tenancy) throw Errors.Conflict('Allocation references a Tenancy outside Tenant scope');
      const tSlices = perTenancy.get(tenancyId);
      const amount = tSlices.reduce((a, s) => a + s.amountCents, 0);
      const key = `${keyBase}:${tenancyId}`;

      const isMpesaReceipt = origin === 'MPESA';
      const isManualReceipt = origin === 'MANUAL';
      const isBankReceipt = origin === 'BANK';

      const [payment] = await Payment.create([{
        clientId,
        estateId,
        // Child payment house is the obligation's tenancy house (may differ from originating house).
        houseId: tenancy.houseId,
        tenantId,
        tenancyId: tenancy._id,
        origin,
        mpesaReceiptId: isMpesaReceipt ? receipt.transactionId : null,
        ...(isBankReceipt ? { bankTransactionId: receipt.bankTransactionId } : {}),
        manualReceiptId: (isManualReceipt || origin === 'CREDIT') && manualReceiptId ? manualReceiptId : null,
        creditApplicationKey: origin === 'CREDIT' ? key : null,
        tenderMethod: isManualReceipt ? (receipt.tenderMethod || null) : (isMpesaReceipt ? 'MPESA' : null),
        recordedByUserId: isManualReceipt ? (receipt.recordedByUserId || null) : null,
        recordedAt: isManualReceipt ? new Date() : null,
        evidenceReference: isManualReceipt ? receipt.identityKey : null,
        amountCents: amount,
        paymentDate: when,
        // MANUAL children must NOT carry the external paymentReference — it lives on ManualReceipt.
        // Putting the same reference on multiple children collides with uniq_client_manual_payment_reference.
        paymentReference: isMpesaReceipt
          ? (receipt.receiptNumber || null)
          : (isBankReceipt ? (receipt.paymentReference || null) : null),
        period: tSlices[0].charge.period,
        status: 'CONFIRMED',
        allocatedCents: 0,
        allocationRev: 0,
      }], { session });

      await ledgerService.postEntry({
        clientId, estateId, houseId: tenancy.houseId, tenantId, tenancyId: tenancy._id,
        accountCategory: 'RENT',
        entryType: origin === 'CREDIT' ? 'SETTLEMENT' : 'PAYMENT',
        amountCents: amount,
        referenceType: 'Payment',
        referenceId: payment._id,
        description: origin === 'CREDIT'
          ? 'Tenant credit applied'
          : (origin === 'MANUAL' ? 'Manual receipt payment' : (origin === 'BANK' ? 'Bank receipt payment' : 'MPESA receipt payment')),
        period: tSlices[0].charge.period,
      }, { session });

      for (const s of tSlices) {
        const scope = { clientId, estateId, houseId: tenancy.houseId, tenancyId: tenancy._id };
        if (!touchedCharges.has(idStr(s.charge._id))) {
          await bumpAllocationRev(RentCharge, s.charge._id, scope, session);
          touchedCharges.add(idStr(s.charge._id));
        }
        const [alloc] = await PaymentAllocation.create([{
          clientId, estateId, paymentId: payment._id, tenancyId: tenancy._id,
          rentChargeId: s.charge._id, amountCents: s.amountCents,
          chargeType: s.charge.chargeType, period: s.charge.period,
        }], { session });
        created.allocations.push({
          paymentId: payment._id,
          tenancyId: tenancy._id,
          houseId: tenancy.houseId,
          rentChargeId: s.charge._id,
          amountCents: s.amountCents,
          chargeType: s.charge.chargeType,
          period: s.charge.period,
          origin,
        });
        if (origin === 'CREDIT') {
          const [mv] = await TenantCreditMovement.create([{
            clientId, estateId, tenantId,
            movementType: CREDIT_MOVEMENT_TYPE.CREDIT_APPLIED,
            amountCents: -s.amountCents,
            mpesaTransactionId: source === 'MPESA' && receipt ? receipt.transactionId : null,
            bankTransactionId: source === 'BANK' && receipt ? receipt.bankTransactionId : null,
            manualReceiptId: manualReceiptId || null,
            paymentId: payment._id, tenancyId: tenancy._id, rentChargeId: s.charge._id,
            idempotencyKey: `${key}:${idStr(s.charge._id)}`,
            creditRevAtWrite: creditRev,
            description: 'credit applied to oldest eligible obligation',
          }], { session });
          created.movements.push(mv);
        }
      }
      out.push(payment);
    }
    return out;
  };

  // Credit first (existing credit pays the oldest), then the receipt.
  const creditKeyBase = receipt
    ? (source === 'MANUAL'
      ? `manual:${receipt.identityKey}`
      : (source === 'BANK'
        ? `bank:${idStr(receipt.bankTransactionId)}`
        : `receipt:${idStr(receipt.transactionId)}`))
    : `auto:${creditRev}`;
  created.creditPayments = await post({ slices: plan.creditSlices, origin: 'CREDIT', keyBase: creditKeyBase });

  if (receipt) {
    const receiptOrigin = source;
    const receiptKeyBase = source === 'MANUAL'
      ? `manual:${receipt.identityKey}`
      : (source === 'BANK'
        ? `bank:${idStr(receipt.bankTransactionId)}`
        : `receipt:${idStr(receipt.transactionId)}`);

    // Only create child Payments for actual allocation slices.
    // Full surplus: no Payment marker (preserves M-PESA behaviour; MANUAL uses ManualReceipt).
    created.receiptPayments = await post({
      slices: plan.receiptSlices,
      origin: receiptOrigin,
      keyBase: receiptKeyBase,
    });

    if (plan.newCreditCents > 0) {
      const surplusKey = source === 'MANUAL'
        ? `manual:${receipt.identityKey}:surplus`
        : (source === 'BANK'
          ? `bank:${idStr(receipt.bankTransactionId)}:surplus`
          : `receipt:${idStr(receipt.transactionId)}:surplus`);
      const [mv] = await TenantCreditMovement.create([{
        clientId, estateId, tenantId,
        movementType: CREDIT_MOVEMENT_TYPE.RECEIPT_SURPLUS,
        amountCents: plan.newCreditCents,
        mpesaTransactionId: source === 'MPESA' ? receipt.transactionId : null,
        bankTransactionId: source === 'BANK' ? receipt.bankTransactionId : null,
        manualReceiptId: manualReceiptId || null,
        paymentId: source === 'BANK' ? null : (created.receiptPayments[0]?._id || null),
        idempotencyKey: surplusKey,
        creditRevAtWrite: creditRev,
        description: 'verified receipt surplus carried forward',
      }], { session });
      created.movements.push(mv);
    }
  }

  // Projections derive from allocations for every touched charge.
  for (const chargeId of [...touchedCharges].sort()) {
    const c = charges.find((x) => idStr(x._id) === chargeId);
    await projectCharge(c._id, {
      clientId, estateId, houseId: c.houseId, tenancyId: c.tenancyId,
    }, session);
  }

  const creditAfter = await creditBalanceCents({ clientId, estateId, tenantId }, { session });
  if (creditAfter !== plan.creditRemainingCents + plan.newCreditCents) {
    throw Errors.Conflict('Tenant credit reconciliation failed');
  }
  return {
    plan: {
      creditAppliedCents: plan.creditAppliedCents,
      creditRemainingCents: plan.creditRemainingCents,
      receiptAppliedCents: plan.receiptAppliedCents,
      newCreditCents: plan.newCreditCents,
    },
    creditBeforeCents: creditBefore,
    creditAfterCents: creditAfter,
    reused: false,
    ...created,
  };
}

/** Standalone auto-application of existing credit to newly eligible charges. */
export async function autoApplyCredit({ clientId, estateId, tenantId }) {
  const probe = await creditBalanceCents({ clientId, estateId, tenantId });
  if (probe <= 0) return { applied: 0 };
  const session = await mongoose.startSession();
  try {
    let result = { applied: 0 };
    await session.withTransaction(async () => {
      const r = await settleTenantAccount({ clientId, estateId, tenantId, session });
      result = { applied: r.plan.creditAppliedCents };
    });
    return result;
  } finally {
    await session.endSession();
  }
}
