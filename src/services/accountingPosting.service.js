/**
 * Shared accounting posting for BANK and MANUAL (G3.3).
 * Concurrency: non-monetary allocationRev CAS on Payment and RentCharge.
 * Derive allocation totals from PaymentAllocation — do not use Payment.allocatedCents as authority.
 */
import mongoose from 'mongoose';
import { Payment } from '../models/Payment.js';
import { Tenancy } from '../models/Tenancy.js';
import { PaymentAllocation } from '../models/PaymentAllocation.js';
import { RentCharge } from '../models/RentCharge.js';
import { ledgerService } from './ledger.service.js';
import { rentService } from './rent.service.js';
import { planAllocation, statusAfterPayment } from '../utils/allocation.js';
import { Errors } from '../utils/errors.js';
import { supportsMongoTransactions } from '../config/database.js';
import { requirePositiveSafeCents } from '../utils/moneyInt.js';
import { areFinancialIndexesReady } from '../utils/ensureIndexes.js';
import { assertBillingIndexesAligned } from '../utils/billingIndexReadiness.js';
import { assertManualPaymentReferenceIndexAligned } from '../utils/manualPaymentIndexReadiness.js';
import { dateUtil } from '../utils/date.js';

function requireTxSupport() {
  if (supportsMongoTransactions() !== true) {
    throw Errors.ServiceUnavailable(
      'MongoDB transactions required and must be verified before financial posting'
    );
  }
}

async function requireIndexes(origin) {
  if (!areFinancialIndexesReady()) {
    throw Errors.ServiceUnavailable('Required financial indexes are not ready');
  }

  try {
    // Re-check critical live constraints before posting; startup flags can become stale.
    await assertBillingIndexesAligned();
    if (origin === 'MANUAL') await assertManualPaymentReferenceIndexAligned();
  } catch (error) {
    throw Errors.ServiceUnavailable(
      `Financial posting indexes are not ready (${error?.report?.reason || error.message})`
    );
  }
}

function sameId(a, b) {
  return a != null && b != null && String(a) === String(b);
}

/** Acquire write point via non-monetary revision increment (CAS serialization). */
async function bumpAllocationRev(model, id, session) {
  const updated = await model.findOneAndUpdate(
    { _id: id },
    { $inc: { allocationRev: 1 } },
    { session, new: true }
  );
  if (!updated) {
    throw Errors.Conflict(`Failed to acquire allocation write point for ${model.modelName}`);
  }
  return updated;
}

async function sumAllocationsForPayment(paymentId, session) {
  const rows = await PaymentAllocation.aggregate([
    { $match: { paymentId } },
    { $group: { _id: null, total: { $sum: '$amountCents' } } },
  ]).session(session);
  return rows[0]?.total || 0;
}

async function sumAllocationsForCharge(rentChargeId, session) {
  const rows = await PaymentAllocation.aggregate([
    { $match: { rentChargeId } },
    { $group: { _id: null, total: { $sum: '$amountCents' } } },
  ]).session(session);
  return rows[0]?.total || 0;
}

async function applyChargeProjection(chargeId, scope, session) {
  const paid = await sumAllocationsForCharge(chargeId, session);
  const charge = await RentCharge.findOne({
    _id: chargeId,
    clientId: scope.clientId,
    estateId: scope.estateId,
    houseId: scope.houseId,
    tenancyId: scope.tenancyId,
  }).session(session);
  if (!charge) {
    throw Errors.Conflict('RentCharge disappeared during allocation projection');
  }
  charge.amountPaidCents = paid;
  charge.balanceCents = charge.amountDueCents - paid;
  charge.status = statusAfterPayment(charge.amountDueCents, paid);
  await charge.save({ session });
  return charge;
}

async function inspectExistingPayment(payment, expected, { session }) {
  if (payment.status !== 'CONFIRMED') {
    throw Errors.Conflict(`Existing Payment status is ${payment.status}; refuse reuse`);
  }
  if (!expected.origin || payment.origin !== expected.origin) {
    throw Errors.Conflict('Existing Payment origin mismatch or missing');
  }
  if (expected.origin === 'BANK') {
    if (!expected.bankTransactionId || !payment.bankTransactionId
      || !sameId(payment.bankTransactionId, expected.bankTransactionId)) {
      throw Errors.Conflict('Existing BANK Payment linkage mismatch');
    }
  }
  if (payment.amountCents !== expected.amountCents) {
    throw Errors.Conflict('Existing Payment amountCents mismatch');
  }
  for (const field of ['clientId', 'estateId', 'houseId', 'tenantId', 'tenancyId']) {
    if (!sameId(payment[field], expected[field])) {
      throw Errors.Conflict(`Existing Payment ${field} ownership mismatch`);
    }
  }
  if (expected.origin === 'MANUAL' && expected.paymentReference !== undefined
    && String(payment.paymentReference || '') !== String(expected.paymentReference || '')) {
    throw Errors.Conflict('Existing Payment paymentReference mismatch');
  }
  if ((expected.origin === 'BANK' || expected.paymentDateWasExplicit)
    && expected.paymentDate != null
    && new Date(payment.paymentDate).getTime() !== new Date(expected.paymentDate).getTime()) {
    throw Errors.Conflict('Existing Payment paymentDate mismatch');
  }
  if (expected.origin === 'MANUAL') {
    if (payment.tenderMethod !== (expected.tenderMethod || null)) {
      throw Errors.Conflict('Existing MANUAL Payment tenderMethod mismatch');
    }
    if (String(payment.evidenceReference || '') !== String(expected.evidenceReference || '')) {
      throw Errors.Conflict('Existing MANUAL Payment evidenceReference mismatch');
    }
  }

  const allocations = await PaymentAllocation.find({ paymentId: payment._id }).session(session).lean();
  let allocatedTotal = 0;
  const chargeTotals = new Map();
  const chargeById = new Map();
  for (const allocation of allocations) {
    if (!sameId(allocation.clientId, payment.clientId)
      || !sameId(allocation.estateId, payment.estateId)
      || !sameId(allocation.tenancyId, payment.tenancyId)
      || !Number.isSafeInteger(allocation.amountCents) || allocation.amountCents <= 0) {
      throw Errors.Conflict('Existing Payment has an allocation with invalid ownership or amount');
    }
    const charge = await RentCharge.findOne({
      _id: allocation.rentChargeId,
      clientId: payment.clientId,
      estateId: payment.estateId,
      houseId: payment.houseId,
      tenancyId: payment.tenancyId,
    }).session(session).lean();
    if (!charge || charge.period !== allocation.period
      || (allocation.chargeType && charge.chargeType !== allocation.chargeType)) {
      throw Errors.Conflict('Existing Payment allocation points outside its exact Tenancy charge scope');
    }
    allocatedTotal += allocation.amountCents;
    if (!Number.isSafeInteger(allocatedTotal)) {
      throw Errors.Conflict('Existing Payment allocation total is not a safe integer');
    }
    chargeTotals.set(String(charge._id), (chargeTotals.get(String(charge._id)) || 0) + allocation.amountCents);
    chargeById.set(String(charge._id), charge);
  }
  if (allocatedTotal > payment.amountCents) {
    throw Errors.Conflict('Existing Payment allocations exceed its received amount');
  }

  // A retry must not conceal a stale RentCharge projection. Verify all allocations
  // for each touched charge, including allocations made by other Payments.
  for (const [chargeId, expectedPaid] of chargeTotals) {
    const rows = await PaymentAllocation.find({ rentChargeId: chargeId }).session(session).lean();
    let totalForCharge = 0;
    for (const row of rows) {
      const charge = chargeById.get(chargeId);
      if (!sameId(row.clientId, payment.clientId)
        || !sameId(row.estateId, payment.estateId)
        || !sameId(row.tenancyId, payment.tenancyId)
        || row.period !== charge.period
        || (row.chargeType && row.chargeType !== charge.chargeType)
        || !Number.isSafeInteger(row.amountCents) || row.amountCents <= 0) {
        throw Errors.Conflict('RentCharge has an allocation outside its expected tenancy/period/line scope');
      }
      totalForCharge += row.amountCents;
      if (!Number.isSafeInteger(totalForCharge)) {
        throw Errors.Conflict('RentCharge allocation total is not a safe integer');
      }
    }
    const charge = chargeById.get(chargeId);
    if (totalForCharge < expectedPaid
      || charge.amountPaidCents !== totalForCharge
      || charge.balanceCents !== charge.amountDueCents - totalForCharge
      || charge.status !== statusAfterPayment(charge.amountDueCents, totalForCharge)) {
      throw Errors.Conflict('Existing RentCharge paid/balance/status projection differs from its allocations');
    }
  }

  // Ensure/verify the exact PAYMENT Ledger movement as part of the retry transaction.
  // If an older partial write left it missing, the shared posting service repairs it.
  const ledger = await ledgerService.postEntry({
    clientId: payment.clientId,
    estateId: payment.estateId,
    houseId: payment.houseId,
    tenantId: payment.tenantId || null,
    tenancyId: payment.tenancyId,
    accountCategory: 'RENT',
    entryType: 'PAYMENT',
    amountCents: payment.amountCents,
    referenceType: 'Payment',
    referenceId: payment._id,
    description: `${payment.origin} payment receipt`,
    period: payment.period || null,
  }, { session });

  return {
    payment,
    allocations,
    ledger: ledger.entry,
    remainingBalanceCents: await ledgerService.currentBalanceForTenancy(
      payment.clientId, payment.tenancyId, 'RENT', { session }
    ),
    unappliedCents: payment.amountCents - allocatedTotal,
    reused: true,
  };
}

/**
 * Post a confirmed payment with allocations and PAYMENT ledger in one transaction.
 */
async function postConfirmedPayment(input, { session: outerSession } = {}) {
  requireTxSupport();
  await requireIndexes(input?.origin);

  const {
    clientId,
    estateId,
    houseId,
    tenantId = null,
    tenancyId,
    amountCents,
    paymentDate,
    paymentDateWasExplicit = false,
    paymentReference = null,
    period = null,
    origin,
    bankTransactionId = null,
    tenderMethod = null,
    recordedByUserId = null,
    evidenceReference = null,
    charges = null,
  } = input;

  if (!tenancyId) {
    throw Errors.InvalidRequest('tenancyId is required for payment posting');
  }
  const amount = requirePositiveSafeCents(amountCents);

  const run = async (session) => {
    // Canonical idempotency lookup for both origins. MANUAL references are
    // protected by the explicit partial unique index installed by G3.3 migration.
    let existing = null;
    if (origin === 'BANK' && bankTransactionId) {
      existing = await Payment.findOne({ clientId, origin: 'BANK', bankTransactionId }).session(session);
    } else if (origin === 'MANUAL' && paymentReference) {
      existing = await Payment.findOne({ clientId, origin: 'MANUAL', paymentReference }).session(session);
    }
    if (existing) {
      return inspectExistingPayment(existing, {
        origin,
        bankTransactionId,
        paymentReference,
        amountCents: amount,
        paymentDate,
        paymentDateWasExplicit: origin === 'BANK' || paymentDateWasExplicit,
        tenderMethod,
        evidenceReference,
        clientId,
        estateId,
        houseId,
        tenantId,
        tenancyId,
      }, { session });
    }

    // Serialize all incoming payments for this Tenancy before reading its
    // outstanding charges. Different payment references must not allocate from
    // the same stale outstanding snapshot.
    const tenancyLock = await Tenancy.updateOne(
      { _id: tenancyId, clientId, estateId, houseId, tenantId },
      { $inc: { ledgerRev: 1 } },
      { session }
    );
    if (tenancyLock.matchedCount !== 1) {
      throw Errors.Conflict('Payment ownership does not match the selected Tenancy');
    }

    const outstanding = charges == null
      ? await rentService.outstandingChargesForTenancy(clientId, tenancyId, { session })
      : charges;
    if (!Array.isArray(outstanding)) {
      throw Errors.InvalidRequest('Supplied RentCharges must be an array');
    }

    // Never filter away a caller-supplied out-of-scope charge. Doing so turns
    // an invalid allocation instruction into a successful unapplied payment.
    // Validate fetched and supplied rows against the full accounting scope.
    for (const charge of outstanding) {
      if (!charge?._id) {
        throw Errors.InvalidRequest('Every supplied RentCharge must have an id');
      }
      if (
        !sameId(charge.clientId, clientId)
        || !sameId(charge.estateId, estateId)
        || !sameId(charge.houseId, houseId)
        || !sameId(charge.tenancyId, tenancyId)
      ) {
        throw Errors.Conflict(
          'Supplied RentCharge is outside payment tenancy scope; cross-tenancy allocation rejected'
        );
      }
    }

    const plan = planAllocation(outstanding, amount);
    for (const step of plan) {
      requirePositiveSafeCents(step.amountCents);
      if (!step.charge?._id) {
        throw Errors.Conflict('Allocation plan references a missing charge');
      }
      if (!sameId(step.charge.tenancyId, tenancyId)) {
        throw Errors.Conflict('Cross-tenancy allocation rejected');
      }
    }

    const primaryPeriod = plan[0]?.charge?.period || period || null;

    const [payment] = await Payment.create([{
      clientId,
      estateId,
      houseId,
      tenantId: tenantId || null,
      tenancyId,
      origin,
      bankTransactionId: bankTransactionId || undefined,
      tenderMethod: tenderMethod || null,
      recordedByUserId: recordedByUserId || null,
      recordedAt: origin === 'MANUAL' ? new Date() : null,
      evidenceReference: evidenceReference || null,
      amountCents: amount,
      paymentDate: paymentDate || new Date(),
      paymentReference: paymentReference || null,
      period: primaryPeriod,
      status: 'CONFIRMED',
      // Deprecated compatibility field — not used as allocation authority
      allocatedCents: 0,
      allocationRev: 0,
    }], { session });

    // Full-amount PAYMENT ledger (allocations do not post additional PAYMENT entries)
    const ledgerResult = await ledgerService.postEntry({
      clientId,
      estateId,
      houseId,
      tenantId: tenantId || null,
      tenancyId,
      accountCategory: 'RENT',
      entryType: 'PAYMENT',
      amountCents: amount,
      referenceType: 'Payment',
      referenceId: payment._id,
      description: `${origin} payment receipt`,
      period: primaryPeriod,
    }, { session });

    // Deterministic charge lock order by id
    const chargeIds = [...new Set(plan.map((s) => String(s.charge._id)))].sort();
    for (const id of chargeIds) {
      await bumpAllocationRev(RentCharge, id, session);
    }
    await bumpAllocationRev(Payment, payment._id, session);

    const allocations = [];
    const scope = { clientId, estateId, houseId, tenancyId };

    for (const step of plan) {
      const allocAmt = requirePositiveSafeCents(step.amountCents);
      const charge = await RentCharge.findOne({
        _id: step.charge._id,
        clientId,
        estateId,
        houseId,
        tenancyId,
      }).session(session);
      if (!charge) {
        throw Errors.Conflict('Planned RentCharge disappeared or left scope; aborting payment');
      }

      // Recompute payment remaining after prior inserts in this txn
      const already = await sumAllocationsForPayment(payment._id, session);
      if (already + allocAmt > amount) {
        throw Errors.Conflict('Payment allocation capacity exceeded');
      }

      try {
        const [alloc] = await PaymentAllocation.create([{
          clientId,
          estateId,
          paymentId: payment._id,
          tenancyId,
          rentChargeId: charge._id,
          amountCents: allocAmt,
          chargeType: charge.chargeType || 'RENT',
          period: charge.period || primaryPeriod || dateUtil.currentPeriod(),
        }], { session });
        allocations.push(alloc);
      } catch (err) {
        if (err?.code === 11000) {
          throw Errors.Conflict('Duplicate allocation for payment/charge');
        }
        throw err;
      }

      await applyChargeProjection(charge._id, scope, session);
    }

    // Optional compatibility mirror (not authority)
    const allocatedTotal = await sumAllocationsForPayment(payment._id, session);
    await Payment.updateOne(
      { _id: payment._id },
      { $set: { allocatedCents: allocatedTotal } },
      { session }
    );

    const committedPayment = await Payment.findById(payment._id).session(session);
    return {
      payment: committedPayment,
      allocations,
      ledger: ledgerResult.entry,
      remainingBalanceCents: await ledgerService.currentBalanceForTenancy(
        clientId, tenancyId, 'RENT', { session }
      ),
      unappliedCents: Math.max(0, amount - allocatedTotal),
      reused: false,
    };
  };

  if (outerSession) {
    return run(outerSession);
  }

  const session = await mongoose.startSession();
  try {
    let result;
    await session.withTransaction(async () => {
      result = await run(session);
    });
    return result;
  } finally {
    session.endSession();
  }
}

export const accountingPostingService = {
  postConfirmedPayment,
  bumpAllocationRev,
  sumAllocationsForPayment,
  sumAllocationsForCharge,
};
