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
 * Returns null-safe fields; never invents a zero when data is missing.
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
    // Positive = net credit; negative = net arrears. Always a defined integer when tenant is known.
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
 * receipt shapes:
 *   MPESA:  { source:'MPESA'|undefined, transactionId, amountCents, receiptNumber?, transactionAt? }
 *   MANUAL: { source:'MANUAL', identityKey, amountCents, tenderMethod, houseId,
 *             paymentReference?, recordedByUserId?, paymentDate? }
 *
 * Manual identityKey is a stable idempotency key (with or without a user reference).
 * MPESA still requires transactionId; that path is unchanged for callers that omit source.
 */
export async function settleTenantAccount({
  clientId, estateId, tenantId, receipt = null, paymentDate = null, session,
}) {
  requireSession(session);

  const source = receipt
    ? (receipt.source === 'MANUAL' ? 'MANUAL' : 'MPESA')
    : null;

  if (receipt) {
    requirePositiveSafeCents(receipt.amountCents);
    if (source === 'MPESA' && !receipt.transactionId) {
      throw Errors.InvalidRequest('receipt.transactionId required');
    }
    if (source === 'MANUAL' && !receipt.identityKey) {
      throw Errors.InvalidRequest('receipt.identityKey required for manual receipts');
    }
  }

  // Idempotent reuse for MANUAL: any prior child Payment with this evidenceReference.
  if (receipt && source === 'MANUAL') {
    const existing = await Payment.find({
      clientId,
      estateId,
      tenantId,
      origin: 'MANUAL',
      evidenceReference: receipt.identityKey,
      status: 'CONFIRMED',
    }).session(session).lean();
    if (existing.length > 0) {
      const creditAfter = await creditBalanceCents({ clientId, estateId, tenantId }, { session });
      const allocated = existing.reduce((s, p) => s + (p.amountCents || 0), 0);
      return {
        plan: {
          creditAppliedCents: 0,
          receiptAppliedCents: Math.min(allocated, receipt.amountCents),
          newCreditCents: Math.max(0, receipt.amountCents - allocated),
        },
        creditBeforeCents: creditAfter,
        creditAfterCents: creditAfter,
        receiptPayments: existing,
        creditPayments: [],
        movements: [],
        reused: true,
      };
    }
  }

  // 1. serialization point for this Tenant's credit account
  const lock = await Tenant.findOneAndUpdate(
    { _id: tenantId, clientId, estateId },
    { $inc: { creditRev: 1 } },
    { session, new: true }
  );
  if (!lock) throw Errors.Conflict('Tenant not found in Client/Estate scope');
  const creditRev = lock.creditRev;

  // 2. lock Tenancies in sorted order, then read obligations
  const { tenancies, charges } = await listObligations({ clientId, estateId, tenantId }, { session });
  for (const t of tenancies) {
    const r = await Tenancy.updateOne({ _id: t._id, clientId, estateId, tenantId }, { $inc: { ledgerRev: 1 } }, { session });
    if (r.matchedCount !== 1) throw Errors.Conflict('Tenancy left scope');
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
  const created = { receiptPayments: [], creditPayments: [], movements: [] };
  const touchedCharges = new Set();

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

      const [payment] = await Payment.create([{
        clientId,
        estateId,
        // Child payment house is the obligation's tenancy house (may differ from originating house).
        houseId: tenancy.houseId,
        tenantId,
        tenancyId: tenancy._id,
        origin,
        mpesaReceiptId: isMpesaReceipt ? receipt.transactionId : null,
        creditApplicationKey: origin === 'CREDIT' ? key : null,
        tenderMethod: isManualReceipt ? (receipt.tenderMethod || null) : (isMpesaReceipt ? 'MPESA' : null),
        recordedByUserId: isManualReceipt ? (receipt.recordedByUserId || null) : null,
        recordedAt: isManualReceipt ? new Date() : null,
        evidenceReference: isManualReceipt ? receipt.identityKey : null,
        amountCents: amount,
        paymentDate: when,
        paymentReference: isMpesaReceipt
          ? (receipt.receiptNumber || null)
          : (isManualReceipt ? (receipt.paymentReference || null) : null),
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
          : (origin === 'MANUAL' ? 'Manual receipt payment' : 'MPESA receipt payment'),
        period: tSlices[0].charge.period,
      }, { session });

      for (const s of tSlices) {
        const scope = { clientId, estateId, houseId: tenancy.houseId, tenancyId: tenancy._id };
        if (!touchedCharges.has(idStr(s.charge._id))) {
          await bumpAllocationRev(RentCharge, s.charge._id, scope, session);
          touchedCharges.add(idStr(s.charge._id));
        }
        await PaymentAllocation.create([{
          clientId, estateId, paymentId: payment._id, tenancyId: tenancy._id,
          rentChargeId: s.charge._id, amountCents: s.amountCents,
          chargeType: s.charge.chargeType, period: s.charge.period,
        }], { session });
        if (origin === 'CREDIT') {
          const [mv] = await TenantCreditMovement.create([{
            clientId, estateId, tenantId,
            movementType: CREDIT_MOVEMENT_TYPE.CREDIT_APPLIED,
            amountCents: -s.amountCents,
            mpesaTransactionId: source === 'MPESA' && receipt ? receipt.transactionId : null,
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
      : `receipt:${idStr(receipt.transactionId)}`)
    : `auto:${creditRev}`;
  created.creditPayments = await post({ slices: plan.creditSlices, origin: 'CREDIT', keyBase: creditKeyBase });

  if (receipt) {
    const receiptOrigin = source === 'MANUAL' ? 'MANUAL' : 'MPESA';
    const receiptKeyBase = source === 'MANUAL'
      ? `manual:${receipt.identityKey}`
      : `receipt:${idStr(receipt.transactionId)}`;

    // Receipt may produce no allocation slices (full surplus → credit) but must still
    // be recorded when there is surplus only — handled via TenantCreditMovement below.
    // When there are slices, create per-tenancy MANUAL/MPESA Payments.
    created.receiptPayments = await post({
      slices: plan.receiptSlices,
      origin: receiptOrigin,
      keyBase: receiptKeyBase,
    });

    // Full-surplus path: no charge was touched by the receipt. Persist a zero-allocation
    // receipt Payment on the occupancy tenancy (caller supplies houseId for MANUAL) so the
    // receipt remains auditable. Prefer an ACTIVE tenancy of this tenant; else first locked.
    if (plan.receiptSlices.length === 0 && plan.newCreditCents === receipt.amountCents) {
      const occupancyHouseId = receipt.houseId || null;
      let anchor = null;
      if (occupancyHouseId) {
        anchor = tenancies.find((t) => String(t.houseId) === String(occupancyHouseId) && t.status === 'ACTIVE')
          || tenancies.find((t) => String(t.houseId) === String(occupancyHouseId))
          || null;
      }
      if (!anchor) {
        anchor = tenancies.find((t) => t.status === 'ACTIVE') || tenancies[0] || null;
      }
      if (anchor) {
        const [marker] = await Payment.create([{
          clientId,
          estateId,
          houseId: occupancyHouseId || anchor.houseId,
          tenantId,
          tenancyId: anchor._id,
          origin: receiptOrigin,
          mpesaReceiptId: source === 'MPESA' ? receipt.transactionId : null,
          creditApplicationKey: null,
          tenderMethod: source === 'MANUAL' ? (receipt.tenderMethod || null) : 'MPESA',
          recordedByUserId: source === 'MANUAL' ? (receipt.recordedByUserId || null) : null,
          recordedAt: source === 'MANUAL' ? new Date() : null,
          evidenceReference: source === 'MANUAL' ? receipt.identityKey : null,
          amountCents: receipt.amountCents,
          paymentDate: when,
          paymentReference: source === 'MPESA'
            ? (receipt.receiptNumber || null)
            : (receipt.paymentReference || null),
          period: null,
          status: 'CONFIRMED',
          allocatedCents: 0,
          allocationRev: 0,
        }], { session });
        // Ledger PAYMENT for the full receipt on the anchor tenancy (surplus becomes credit;
        // credit movement is the tenant-level carry-forward, not a second PAYMENT).
        await ledgerService.postEntry({
          clientId, estateId, houseId: marker.houseId, tenantId, tenancyId: anchor._id,
          accountCategory: 'RENT',
          entryType: 'PAYMENT',
          amountCents: receipt.amountCents,
          referenceType: 'Payment',
          referenceId: marker._id,
          description: source === 'MANUAL' ? 'Manual receipt (credit only)' : 'MPESA receipt (credit only)',
          period: null,
        }, { session });
        created.receiptPayments.push(marker);
      }
    }

    if (plan.newCreditCents > 0) {
      const surplusKey = source === 'MANUAL'
        ? `manual:${receipt.identityKey}:surplus`
        : `receipt:${idStr(receipt.transactionId)}:surplus`;
      const [mv] = await TenantCreditMovement.create([{
        clientId, estateId, tenantId,
        movementType: CREDIT_MOVEMENT_TYPE.RECEIPT_SURPLUS,
        amountCents: plan.newCreditCents,
        mpesaTransactionId: source === 'MPESA' ? receipt.transactionId : null,
        paymentId: created.receiptPayments[0]?._id || null,
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
