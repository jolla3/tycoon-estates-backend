// Bank-agnostic reconciliation and G5 shared tenant-account settlement.
// BankTransaction is the gross receipt envelope; Payment children represent
// destination-tenancy allocations and may be absent when the receipt is all credit.

import mongoose from 'mongoose';
import { House } from '../models/House.js';
import { Tenant } from '../models/Tenant.js';
import { Payment } from '../models/Payment.js';
import { PaymentAllocation } from '../models/PaymentAllocation.js';
import { TenantCreditMovement } from '../models/TenantCreditMovement.js';
import { BankTransaction } from '../models/BankTransaction.js';
import { Tenancy } from '../models/Tenancy.js';
import { smsService } from './sms.service.js';
import { dateUtil } from '../utils/date.js';
import { escapeRegex } from '../utils/regex.js';
import { logger } from '../config/logger.js';
import { audit } from './audit.service.js';
import { tenancyContains } from './tenancy.service.js';
import { claimBankTransaction } from './banking/processingClaim.js';
import { settleTenantAccount, tenantAccountSnapshot } from './tenantCredit.service.js';
import { assertBankPaymentIndexesAligned } from '../utils/bankPaymentIndexReadiness.js';
import { assertPaymentReceiptIndexesAligned } from '../utils/paymentReceiptIndexReadiness.js';
import { areFinancialIndexesReady } from '../utils/ensureIndexes.js';
import { supportsMongoTransactions } from '../config/database.js';
import { Errors } from '../utils/errors.js';

const sameId = (a, b) => a != null && b != null && String(a) === String(b);

async function assertBankSettlementReady() {
  if (supportsMongoTransactions() !== true) {
    throw Errors.ServiceUnavailable('MongoDB transactions are required for Bank settlement');
  }
  if (!areFinancialIndexesReady()) {
    throw Errors.ServiceUnavailable('Required financial indexes are not ready for Bank settlement');
  }
  try {
    await assertPaymentReceiptIndexesAligned();
  } catch {
    throw Errors.ServiceUnavailable('Shared tenant-account Payment receipt/credit indexes are not aligned');
  }
  await assertBankPaymentIndexesAligned();
  return true;
}

async function findHouseByReference(clientId, estateId, reference) {
  if (!reference) return null;
  const pattern = new RegExp('^' + escapeRegex(reference) + '$', 'i');
  const matches = await House.find({
    clientId,
    estateId,
    isActive: true,
    $or: [
      { houseNumber: pattern },
      { paymentReferences: pattern },
    ],
  }).lean();
  // A number match must not silently win over another House's alias match.
  // Exact reference evidence is useful only when it identifies one House.
  return matches.length === 1 ? matches[0] : null;
}

function settlementFields({ settled, postedAt }) {
  const paymentIds = (settled.receiptPayments || []).map((payment) => payment._id);
  const creditPaymentIds = (settled.creditPayments || []).map((payment) => payment._id);
  const creditMovementIds = (settled.movements || []).map((movement) => movement._id);
  const creditBeforeCents = settled.creditBeforeCents;
  const creditRemainingCents = settled.plan.creditRemainingCents;
  const creditAfterCents = settled.creditAfterCents;
  const { receiptAppliedCents, creditAppliedCents, newCreditCents } = settled.plan;

  if (![creditBeforeCents, creditRemainingCents, creditAfterCents,
    receiptAppliedCents, creditAppliedCents, newCreditCents]
    .every((value) => Number.isSafeInteger(value) && value >= 0)) {
    throw Errors.Conflict('Bank settlement returned incomplete integer-cent reconciliation values');
  }
  if (receiptAppliedCents + newCreditCents !== settled.receiptAmountCents) {
    throw Errors.Conflict('Bank receipt gross amount does not reconcile with receipt allocations and new credit');
  }
  if (creditAppliedCents + creditRemainingCents !== creditBeforeCents) {
    throw Errors.Conflict('Bank settlement existing-credit conservation failed');
  }
  if (creditAfterCents !== creditRemainingCents + newCreditCents) {
    throw Errors.Conflict('Bank settlement resulting-credit balance does not reconcile');
  }

  return {
    paymentIds,
    creditPaymentIds,
    creditMovementIds,
    receiptAppliedCents,
    creditAppliedCents,
    newCreditCents,
    creditBeforeCents,
    creditRemainingCents,
    creditAfterCents,
    settlementVersion: 1,
    postedAt,
  };
}

function persistedSummary(bankTransaction) {
  return {
    paymentIds: bankTransaction.paymentIds || [],
    creditPaymentIds: bankTransaction.creditPaymentIds || [],
    creditMovementIds: bankTransaction.creditMovementIds || [],
    receiptAppliedCents: bankTransaction.receiptAppliedCents,
    creditAppliedCents: bankTransaction.creditAppliedCents,
    newCreditCents: bankTransaction.newCreditCents,
    creditBeforeCents: bankTransaction.creditBeforeCents,
    creditRemainingCents: bankTransaction.creditRemainingCents,
    creditAfterCents: bankTransaction.creditAfterCents,
    settlementVersion: bankTransaction.settlementVersion,
    postedAt: bankTransaction.postedAt,
  };
}

function orderByIds(ids, docs) {
  const byId = new Map(docs.map((doc) => [String(doc._id), doc]));
  return ids.map((id) => byId.get(String(id))).filter(Boolean);
}

async function reconstructPostedSettlement(bankTransaction) {
  const summary = persistedSummary(bankTransaction);
  const paymentIds = summary.paymentIds || [];
  const creditPaymentIds = summary.creditPaymentIds || [];
  const movementIds = summary.creditMovementIds || [];
  const allPaymentIds = [...paymentIds, ...creditPaymentIds];

  const [receiptRows, creditRows, movementRows] = await Promise.all([
    paymentIds.length
      ? Payment.find({
        _id: { $in: paymentIds },
        clientId: bankTransaction.clientId,
        estateId: bankTransaction.estateId,
        tenantId: bankTransaction.matchedTenantId,
        origin: 'BANK',
        bankTransactionId: bankTransaction._id,
      }).lean()
      : Promise.resolve([]),
    creditPaymentIds.length
      ? Payment.find({
        _id: { $in: creditPaymentIds },
        clientId: bankTransaction.clientId,
        estateId: bankTransaction.estateId,
        tenantId: bankTransaction.matchedTenantId,
        origin: 'CREDIT',
      }).lean()
      : Promise.resolve([]),
    movementIds.length
      ? TenantCreditMovement.find({
        _id: { $in: movementIds },
        clientId: bankTransaction.clientId,
        estateId: bankTransaction.estateId,
        tenantId: bankTransaction.matchedTenantId,
        bankTransactionId: bankTransaction._id,
      }).lean()
      : Promise.resolve([]),
  ]);
  if (receiptRows.length !== paymentIds.length
    || creditRows.length !== creditPaymentIds.length
    || movementRows.length !== movementIds.length) {
    throw Errors.Conflict('POSTED Bank receipt summary references missing or out-of-scope financial records');
  }

  const receiptPayments = orderByIds(paymentIds, receiptRows);
  const creditPayments = orderByIds(creditPaymentIds, creditRows);
  const movements = orderByIds(movementIds, movementRows);
  const allocationRows = allPaymentIds.length
    ? await PaymentAllocation.find({
      paymentId: { $in: allPaymentIds },
      clientId: bankTransaction.clientId,
      estateId: bankTransaction.estateId,
    }).lean()
    : [];
  const paymentById = new Map([
    ...receiptPayments.map((payment) => [String(payment._id), payment]),
    ...creditPayments.map((payment) => [String(payment._id), payment]),
  ]);
  const allocations = allocationRows.map((allocation) => {
    const payment = paymentById.get(String(allocation.paymentId));
    if (!payment || !sameId(payment.tenancyId, allocation.tenancyId)) {
      throw Errors.Conflict('POSTED Bank receipt allocation no longer matches its destination Payment tenancy');
    }
    return {
      paymentId: allocation.paymentId,
      tenancyId: allocation.tenancyId,
      houseId: payment.houseId,
      rentChargeId: allocation.rentChargeId,
      amountCents: allocation.amountCents,
      chargeType: allocation.chargeType,
      period: allocation.period,
      origin: payment.origin,
    };
  });

  const allocatedByPayment = new Map();
  for (const allocation of allocations) {
    const key = String(allocation.paymentId);
    allocatedByPayment.set(key, (allocatedByPayment.get(key) || 0) + allocation.amountCents);
  }
  for (const payment of [...receiptPayments, ...creditPayments]) {
    if (!Number.isSafeInteger(allocatedByPayment.get(String(payment._id)))
      || allocatedByPayment.get(String(payment._id)) !== payment.amountCents) {
      throw Errors.Conflict('POSTED Bank receipt Payment amount does not match its persisted allocation rows');
    }
  }

  const sumPayments = (rows) => rows.reduce((total, payment) => total + payment.amountCents, 0);
  const receiptPaymentIdSet = new Set(receiptPayments.map((payment) => String(payment._id)));
  const creditPaymentIdSet = new Set(creditPayments.map((payment) => String(payment._id)));
  const allocationByPaymentCharge = new Map(
    allocationRows.map((allocation) => [
      String(allocation.paymentId) + ':' + String(allocation.rentChargeId),
      allocation,
    ])
  );
  const creditAppliedByPayment = new Map();
  let creditAppliedFromMovements = 0;
  let newCreditFromMovements = 0;
  for (const movement of movements) {
    if (movement.movementType === 'CREDIT_APPLIED') {
      const paymentId = movement.paymentId ? String(movement.paymentId) : null;
      const allocation = paymentId && movement.rentChargeId
        ? allocationByPaymentCharge.get(paymentId + ':' + String(movement.rentChargeId))
        : null;
      if (!paymentId || !creditPaymentIdSet.has(paymentId)
        || !allocation || !sameId(allocation.tenancyId, movement.tenancyId)
        || !Number.isSafeInteger(movement.amountCents) || movement.amountCents >= 0
        || -movement.amountCents !== allocation.amountCents) {
        throw Errors.Conflict('POSTED Bank CREDIT_APPLIED movement does not match its credit Payment allocation');
      }
      creditAppliedByPayment.set(
        paymentId,
        (creditAppliedByPayment.get(paymentId) || 0) - movement.amountCents
      );
      creditAppliedFromMovements -= movement.amountCents;
    } else if (movement.movementType === 'RECEIPT_SURPLUS') {
      if (movement.paymentId != null
        || !Number.isSafeInteger(movement.amountCents) || movement.amountCents <= 0) {
        throw Errors.Conflict('POSTED Bank RECEIPT_SURPLUS movement has invalid payment linkage or amount');
      }
      newCreditFromMovements += movement.amountCents;
    } else {
      throw Errors.Conflict('POSTED Bank receipt references an unexpected TenantCreditMovement type');
    }
  }
  for (const payment of creditPayments) {
    if (creditAppliedByPayment.get(String(payment._id)) !== payment.amountCents) {
      throw Errors.Conflict('POSTED Bank credit Payment does not reconcile to its CREDIT_APPLIED movements');
    }
  }
  if (receiptPayments.some((payment) => !receiptPaymentIdSet.has(String(payment._id)))) {
    throw Errors.Conflict('POSTED Bank receipt child identity could not be verified');
  }
  const values = [
    bankTransaction.amountCents,
    summary.receiptAppliedCents,
    summary.creditAppliedCents,
    summary.newCreditCents,
    summary.creditBeforeCents,
    summary.creditRemainingCents,
    summary.creditAfterCents,
  ];
  if (!values.every((value) => Number.isSafeInteger(value) && value >= 0)
    || sumPayments(receiptPayments) !== summary.receiptAppliedCents
    || sumPayments(creditPayments) !== summary.creditAppliedCents
    || creditAppliedFromMovements !== summary.creditAppliedCents
    || newCreditFromMovements !== summary.newCreditCents
    || summary.receiptAppliedCents + summary.newCreditCents !== bankTransaction.amountCents
    || summary.creditAppliedCents + summary.creditRemainingCents !== summary.creditBeforeCents
    || summary.creditRemainingCents + summary.newCreditCents !== summary.creditAfterCents) {
    throw Errors.Conflict('POSTED Bank receipt persisted conservation checks failed');
  }

  const destinationTenancyIds = [...new Set([
    ...receiptPayments,
    ...creditPayments,
  ].map((payment) => payment.tenancyId ? String(payment.tenancyId) : null).filter(Boolean))];
  if ([...receiptPayments, ...creditPayments].some((payment) => !payment.tenancyId || !payment.houseId)) {
    throw Errors.Conflict('POSTED Bank receipt child Payment is missing its destination Tenancy or House identity');
  }
  const [house, tenant, sourceTenancy, destinationTenancies] = await Promise.all([
    bankTransaction.matchedHouseId
      ? House.findOne({
        _id: bankTransaction.matchedHouseId,
        clientId: bankTransaction.clientId,
        estateId: bankTransaction.estateId,
      }).lean()
      : Promise.resolve(null),
    bankTransaction.matchedTenantId
      ? Tenant.findOne({
        _id: bankTransaction.matchedTenantId,
        clientId: bankTransaction.clientId,
      }).lean()
      : Promise.resolve(null),
    bankTransaction.matchedTenancyId
      ? Tenancy.findOne({
        _id: bankTransaction.matchedTenancyId,
        clientId: bankTransaction.clientId,
        estateId: bankTransaction.estateId,
        houseId: bankTransaction.matchedHouseId,
        tenantId: bankTransaction.matchedTenantId,
        status: { $in: ['ACTIVE', 'CLOSED'] },
      }).lean()
      : Promise.resolve(null),
    destinationTenancyIds.length
      ? Tenancy.find({
        _id: { $in: destinationTenancyIds },
        clientId: bankTransaction.clientId,
        estateId: bankTransaction.estateId,
        tenantId: bankTransaction.matchedTenantId,
        status: { $in: ['ACTIVE', 'CLOSED'] },
      }).lean()
      : Promise.resolve([]),
  ]);
  if (!sourceTenancy || !tenancyContains(sourceTenancy, bankTransaction.transactionDate)
    || destinationTenancies.length !== destinationTenancyIds.length) {
    throw Errors.Conflict('POSTED Bank receipt source or destination Tenancy identity is no longer verifiable');
  }
  const destinationById = new Map(destinationTenancies.map((tenancy) => [String(tenancy._id), tenancy]));
  for (const payment of [...receiptPayments, ...creditPayments]) {
    const destination = destinationById.get(String(payment.tenancyId));
    if (!destination || !sameId(destination.houseId, payment.houseId)) {
      throw Errors.Conflict('POSTED Bank receipt Payment House does not match its destination Tenancy');
    }
  }
  if (!house || !tenant || !sameId(sourceTenancy.houseId, house._id)
    || !sameId(sourceTenancy.tenantId, tenant._id)) {
    throw Errors.Conflict('POSTED Bank receipt source House/Tenant/Token linkage is no longer verifiable');
  }
  let remainingBalanceCents = null;
  if (tenant) {
    const account = await tenantAccountSnapshot({
      clientId: bankTransaction.clientId,
      estateId: bankTransaction.estateId,
      tenantId: tenant._id,
    });
    remainingBalanceCents = Math.max(account.outstandingCents - account.creditCents, 0);
  }

  return {
    matched: true,
    reused: true,
    bankTransaction,
    payment: receiptPayments[0] || null,
    payments: receiptPayments,
    creditPayments,
    creditMovements: movements,
    allocations,
    summary,
    house,
    tenant,
    remainingBalanceCents,
  };
}

async function markG4ClaimManualReview(bankTransaction, claimToken, reason, extraSet = {}) {
  const now = new Date();
  const result = await BankTransaction.updateOne(
    {
      _id: bankTransaction._id,
      clientId: bankTransaction.clientId,
      estateId: bankTransaction.estateId,
      provider: bankTransaction.provider,
      providerTransactionId: bankTransaction.providerTransactionId,
      processingState: 'CLAIMED',
      processingClaimToken: claimToken,
      processingClaimExpiresAt: { $gt: now },
    },
    {
      $set: {
        ...extraSet,
        matchStatus: 'UNMATCHED',
        processingState: 'MANUAL_REVIEW',
        processingClaimToken: null,
        processingClaimExpiresAt: null,
        lastProcessingError: String(reason || 'Bank receipt requires manual review').slice(0, 500),
      },
    }
  );
  if (result.matchedCount !== 1) {
    throw Errors.Conflict('Bank transaction processing claim is expired, missing, or no longer owned');
  }
  Object.assign(bankTransaction, extraSet, {
    matchStatus: 'UNMATCHED',
    processingState: 'MANUAL_REVIEW',
    processingClaimToken: null,
    processingClaimExpiresAt: null,
    lastProcessingError: String(reason || 'Bank receipt requires manual review').slice(0, 500),
  });
  return { matched: false, bankTransaction, reason: 'manual_review' };
}

/**
 * Shared implementation for automatic and manual Bank assignment.
 * Automatic work must own a current G4 claim. Manual assignment has already
 * performed its conditional BankTransaction ownership write in the caller's
 * transaction, so it is accepted only in that explicitly identified state.
 */
async function applyBankReceipt({
  bankTransaction,
  house,
  tenant,
  session,
  tenancyId,
  claimToken = null,
  manualAssignment = false,
}) {
  if (!session) throw Errors.ServiceUnavailable('Bank settlement requires the caller MongoDB transaction');
  if (!tenancyId) throw Errors.InvalidRequest('Source Tenancy is required for Bank receipt attribution');

  const now = new Date();
  const current = await BankTransaction.findOne({
    _id: bankTransaction._id,
    clientId: bankTransaction.clientId,
    estateId: bankTransaction.estateId,
    provider: bankTransaction.provider,
    providerTransactionId: bankTransaction.providerTransactionId,
    eventType: 'CREDIT',
  }).session(session).lean();
  if (!current) throw Errors.Conflict('Bank receipt identity or ownership changed before settlement');
  if (!Number.isSafeInteger(current.amountCents) || current.amountCents <= 0
    || !(current.transactionDate instanceof Date)
    || !Number.isFinite(current.transactionDate.getTime())) {
    throw Errors.InvalidRequest('Bank receipt amount or transactionDate is invalid');
  }

  if (manualAssignment) {
    if (current.processingState !== 'POSTED' || current.matchStatus !== 'MATCHED'
      || current.processingClaimToken != null || current.processingClaimExpiresAt != null
      || !sameId(current.matchedHouseId, house._id)
      || !sameId(current.matchedTenantId, tenant._id)
      || !sameId(current.matchedTenancyId, tenancyId)) {
      throw Errors.Conflict('Manual Bank assignment no longer owns the exact matched transaction');
    }
  } else if (typeof claimToken !== 'string' || !claimToken.trim()
    || current.processingState !== 'CLAIMED'
    || current.processingClaimToken !== claimToken
    || !(current.processingClaimExpiresAt instanceof Date)
    || current.processingClaimExpiresAt <= now) {
    throw Errors.Conflict('Bank processing claim is expired, missing, or no longer owned');
  }

  if (!sameId(current.clientId, house.clientId) || !sameId(current.estateId, house.estateId)
    || !sameId(current.clientId, tenant.clientId)) {
    throw Errors.Conflict('Bank receipt, source House and Tenant client/estate scope mismatch');
  }

  // Re-read source identity here; the shared settlement service acquires the
  // Tenant and sorted Tenancy fences, then rechecks the timestamp under those
  // fences through sourceTenancyCheck. Do not lock a Tenancy before Tenant.
  const sourceTenancy = await Tenancy.findOne({
    _id: tenancyId,
    clientId: current.clientId,
    estateId: current.estateId,
    houseId: house._id,
    tenantId: tenant._id,
    status: { $in: ['ACTIVE', 'CLOSED'] },
  }).session(session).lean();
  if (!sourceTenancy || !tenancyContains(sourceTenancy, current.transactionDate)) {
    throw Errors.Conflict('Bank transactionDate is outside the exact historical source Tenancy');
  }

  const sourceHouse = await House.findOne({
    _id: sourceTenancy.houseId,
    clientId: current.clientId,
    estateId: current.estateId,
  }).session(session).lean();
  const sourceTenant = await Tenant.findOne({
    _id: sourceTenancy.tenantId,
    clientId: current.clientId,
  }).session(session).lean();
  if (!sourceHouse || !sourceTenant
    || !sameId(sourceHouse._id, house._id)
    || !sameId(sourceTenant._id, tenant._id)) {
    throw Errors.Conflict('Bank source House/Tenant could not be revalidated from the historical Tenancy');
  }

  const matchedIdentity = {
    matchedHouseId: sourceHouse._id,
    matchedTenantId: sourceTenant._id,
    matchedTenancyId: sourceTenancy._id,
  };
  for (const field of Object.keys(matchedIdentity)) {
    const value = current[field];
    if (value != null && !sameId(value, matchedIdentity[field])) {
      throw Errors.Conflict('Bank transaction ' + field + ' differs from the verified source Tenancy');
    }
  }

  // An unposted receipt with existing Bank children/movements is legacy or
  // partially repaired data. Never infer/replay financial effects from them.
  const [existingPayments, existingMovements] = await Promise.all([
    Payment.find({ origin: 'BANK', bankTransactionId: current._id })
      .session(session).select('_id clientId estateId tenantId tenancyId amountCents').lean(),
    TenantCreditMovement.find({ bankTransactionId: current._id })
      .session(session).select('_id clientId estateId tenantId movementType amountCents').lean(),
  ]);
  if (existingPayments.length || existingMovements.length
    || current.settlementVersion != null
    || (current.paymentIds || []).length
    || (current.creditPaymentIds || []).length
    || (current.creditMovementIds || []).length) {
    throw Errors.Conflict('Unposted Bank receipt already has linked financial children, summary references, or credit movements; legacy reconciliation is required');
  }

  const settled = await settleTenantAccount({
    clientId: current.clientId,
    estateId: current.estateId,
    tenantId: sourceTenant._id,
    receipt: {
      source: 'BANK',
      bankTransactionId: current._id,
      amountCents: current.amountCents,
      paymentDate: current.transactionDate,
      paymentReference: current.paymentReference || null,
    },
    paymentDate: current.transactionDate,
    sourceTenancyCheck: {
      tenancyId: sourceTenancy._id,
      houseId: sourceHouse._id,
      transactionAt: current.transactionDate,
      allowedStatuses: manualAssignment ? ['ACTIVE', 'CLOSED'] : ['ACTIVE'],
    },
    session,
  });
  settled.receiptAmountCents = current.amountCents;
  const summary = settlementFields({ settled, postedAt: new Date() });

  // A failed condition throws and aborts all financial records written above.
  const finalFilter = manualAssignment
    ? {
        _id: current._id,
        clientId: current.clientId,
        estateId: current.estateId,
        provider: current.provider,
        providerTransactionId: current.providerTransactionId,
        eventType: 'CREDIT',
        processingState: 'POSTED',
        matchStatus: 'MATCHED',
        processingClaimToken: null,
        processingClaimExpiresAt: null,
        matchedHouseId: sourceHouse._id,
        matchedTenantId: sourceTenant._id,
        matchedTenancyId: sourceTenancy._id,
      }
    : {
        _id: current._id,
        clientId: current.clientId,
        estateId: current.estateId,
        provider: current.provider,
        providerTransactionId: current.providerTransactionId,
        eventType: 'CREDIT',
        amountCents: current.amountCents,
        transactionDate: current.transactionDate,
        processingState: 'CLAIMED',
        processingClaimToken: claimToken,
        processingClaimExpiresAt: { $gt: new Date() },
      };
  const final = await BankTransaction.updateOne(
    finalFilter,
    {
      $set: {
        ...matchedIdentity,
        matchStatus: 'MATCHED',
        processingState: 'POSTED',
        processingClaimToken: null,
        processingClaimExpiresAt: null,
        lastProcessingError: null,
        ...summary,
      },
    },
    { session }
  );
  if (final.matchedCount !== 1) {
    throw Errors.Conflict('Bank processing claim or manual assignment fence was lost; settlement aborted');
  }

  const account = await tenantAccountSnapshot({
    clientId: current.clientId,
    estateId: current.estateId,
    tenantId: sourceTenant._id,
  }, { session });

  Object.assign(bankTransaction, matchedIdentity, {
    matchStatus: 'MATCHED',
    processingState: 'POSTED',
    processingClaimToken: null,
    processingClaimExpiresAt: null,
    lastProcessingError: null,
    ...summary,
  });

  return {
    bankTransaction,
    house: sourceHouse,
    tenant: sourceTenant,
    payment: settled.receiptPayments[0] || null,
    receiptPayments: settled.receiptPayments,
    creditPayments: settled.creditPayments,
    creditMovements: settled.movements,
    allocations: settled.allocations,
    plan: settled.plan,
    summary,
    remainingBalanceCents: Math.max(account.outstandingCents - account.creditCents, 0),
    reused: false,
  };
}

export const reconciliationService = {
  assertSettlementReady: assertBankSettlementReady,

  async reconcile(bankTransaction, options = {}) {
    let claimToken = options?.claimToken;
    const hasClaimToken = claimToken !== undefined && claimToken !== null;
    if (hasClaimToken && (typeof claimToken !== 'string' || !claimToken.trim())) {
      throw Errors.InvalidRequest('A non-empty G4 processing claim token is required');
    }
    let current = await BankTransaction.findOne({
      _id: bankTransaction?._id,
      clientId: bankTransaction?.clientId,
      estateId: bankTransaction?.estateId,
    }).lean();
    if (!current) throw Errors.PaymentNotFound('Bank transaction not found');
    if (current.eventType !== 'CREDIT' && current.matchStatus === 'MATCHED') {
      throw Errors.Conflict('MATCHED BankTransaction is not a CREDIT; manual financial review required');
    }
    if (current.eventType !== 'CREDIT' && current.processingState === 'POSTED') {
      return { matched: false, reused: true, bankTransaction: current, reason: 'not_a_credit' };
    }

    if (current.processingState === 'POSTED') {
      if (current.settlementVersion === 1) {
        return reconstructPostedSettlement(current);
      }
      // Historical G4 postings predate the Bank envelope. Do not silently
      // retrofit their allocation or create tenant credit on a replay.
      return { matched: true, reused: true, legacyPosted: true, bankTransaction: current };
    }

    // Preserve the existing direct internal entry point without allowing
    // tokenless posting: acquire the same normal G4 claim used by ingestion.
    if (!hasClaimToken) {
      const claim = await claimBankTransaction(current._id);
      if (!claim.claimed || !claim.claimToken || !claim.doc) {
        throw Errors.Conflict('Bank transaction is already claimed or is not eligible for reconciliation');
      }
      claimToken = claim.claimToken;
      bankTransaction = claim.doc;
      current = await BankTransaction.findById(current._id).lean();
      if (!current) throw Errors.PaymentNotFound('Bank transaction not found');
    }

    if (current.processingState !== 'CLAIMED'
      || current.processingClaimToken !== claimToken
      || !(current.processingClaimExpiresAt instanceof Date)
      || current.processingClaimExpiresAt <= new Date()) {
      throw Errors.Conflict('Bank processing claim is expired, missing, or no longer owned');
    }
    if (current.eventType !== 'CREDIT') {
      return markG4ClaimManualReview(bankTransaction, claimToken, 'Only CREDIT Bank transactions can be posted as rent receipts');
    }
    if (!Number.isSafeInteger(current.amountCents) || current.amountCents <= 0
      || !(current.transactionDate instanceof Date)
      || !Number.isFinite(current.transactionDate.getTime())) {
      return markG4ClaimManualReview(bankTransaction, claimToken, 'Bank receipt amount or transactionDate is invalid');
    }

    let house = null;
    let sourceTenancy = null;
    if (current.matchedHouseId || current.matchedTenantId || current.matchedTenancyId) {
      if (!current.matchedHouseId || !current.matchedTenantId || !current.matchedTenancyId) {
        return markG4ClaimManualReview(bankTransaction, claimToken, 'Bank receipt has incomplete historical source attribution');
      }
      sourceTenancy = await Tenancy.findOne({
        _id: current.matchedTenancyId,
        clientId: current.clientId,
        estateId: current.estateId,
        houseId: current.matchedHouseId,
        tenantId: current.matchedTenantId,
        status: { $in: ['ACTIVE', 'CLOSED'] },
      }).lean();
      if (!sourceTenancy || !tenancyContains(sourceTenancy, current.transactionDate)) {
        return markG4ClaimManualReview(bankTransaction, claimToken, 'Stored matched Tenancy does not cover the Bank transactionDate');
      }
      house = await House.findOne({
        _id: current.matchedHouseId, clientId: current.clientId, estateId: current.estateId,
      }).lean();
    } else {
      const reference = (current.paymentReference || current.narration || '').trim();
      house = await findHouseByReference(current.clientId, current.estateId, reference);
      if (!house) {
        return markG4ClaimManualReview(bankTransaction, claimToken, 'Bank transaction could not be matched to a House');
      }
      const candidates = await Tenancy.find({
        clientId: current.clientId,
        estateId: current.estateId,
        houseId: house._id,
        status: { $in: ['ACTIVE', 'CLOSED'] },
        startAt: { $lte: current.transactionDate },
        $or: [{ endAt: null }, { endAt: { $gt: current.transactionDate } }],
      }).sort({ startAt: 1, _id: 1 }).lean();
      if (candidates.length !== 1) {
        return markG4ClaimManualReview(
          bankTransaction,
          claimToken,
          candidates.length
            ? 'More than one Tenancy covers the Bank transactionDate'
            : 'No Tenancy covers the Bank transactionDate',
          { matchedHouseId: house._id },
        );
      }
      sourceTenancy = candidates[0];
    }

    if (!house || !sourceTenancy
      || !sameId(sourceTenancy.clientId, current.clientId)
      || !sameId(sourceTenancy.estateId, current.estateId)
      || !sameId(sourceTenancy.houseId, house._id)
      || !tenancyContains(sourceTenancy, current.transactionDate)) {
      return markG4ClaimManualReview(bankTransaction, claimToken, 'Bank source House/Tenancy ownership could not be verified');
    }
    if (sourceTenancy.status === 'CLOSED') {
      return markG4ClaimManualReview(
        bankTransaction,
        claimToken,
        'Bank transaction is historically attributed to a CLOSED Tenancy and requires explicit manual review',
        {
          matchedHouseId: house._id,
          matchedTenantId: sourceTenancy.tenantId,
          matchedTenancyId: sourceTenancy._id,
        },
      );
    }
    const tenant = await Tenant.findOne({
      _id: sourceTenancy.tenantId,
      clientId: current.clientId,
    }).lean();
    if (!tenant) {
      return markG4ClaimManualReview(bankTransaction, claimToken, 'Historical source Tenant is missing or outside client/estate scope');
    }

    // listIndexes-based readiness checks must run outside MongoDB transactions.
    await assertBankSettlementReady();
    const session = await mongoose.startSession();
    let posted;
    try {
      await session.withTransaction(async () => {
        posted = await applyBankReceipt({
          bankTransaction,
          house,
          tenant,
          session,
          tenancyId: sourceTenancy._id,
          claimToken,
        });
      });
    } finally {
      await session.endSession();
    }

    await audit({
      clientId: current.clientId,
      estateId: current.estateId,
      action: 'PAYMENT_RECONCILED',
      resource: 'BankTransaction',
      resourceId: current._id,
      metadata: {
        bankTransactionId: String(current._id),
        sourceHouseId: String(posted.house._id),
        sourceTenancyId: String(sourceTenancy._id),
        tenantId: String(posted.tenant._id),
        amountCents: current.amountCents,
        paymentIds: posted.summary.paymentIds.map(String),
        receiptAppliedCents: posted.summary.receiptAppliedCents,
        newCreditCents: posted.summary.newCreditCents,
        creditAppliedCents: posted.summary.creditAppliedCents,
      },
    });
    for (const allocation of posted.allocations || []) {
      await audit({
        clientId: current.clientId,
        estateId: current.estateId,
        action: 'PAYMENT_ALLOCATED',
        resource: 'PaymentAllocation',
        resourceId: allocation.rentChargeId,
        metadata: {
          paymentId: String(allocation.paymentId),
          destinationTenancyId: String(allocation.tenancyId),
          destinationHouseId: String(allocation.houseId),
          amountCents: allocation.amountCents,
          chargeType: allocation.chargeType,
          period: allocation.period,
        },
      });
    }

    if (posted.tenant?.phone) {
      try {
        await smsService.sendPaymentConfirmation({
          clientId: current.clientId,
          estateId: current.estateId,
          tenantId: posted.tenant._id,
          houseId: posted.house._id,
          phone: posted.tenant.phone,
          tenantName: posted.tenant.name,
          houseNumber: posted.house.houseNumber,
          amountCents: current.amountCents,
          balanceCents: posted.remainingBalanceCents,
          currency: current.currency || 'KES',
          period: dateUtil.periodOf(current.transactionDate),
          notificationVersion: 'payment_confirmation:v1',
          idempotencyKey: 'bank-payment-confirmation:' + String(current._id) + ':' + String(posted.tenant._id),
        });
      } catch (smsError) {
        logger.warn(
          { bankTransactionId: String(current._id), estateId: String(current.estateId), code: smsError.code || 'PAYMENT_SMS_QUEUE_FAILED' },
          'Bank payment posted but confirmation SMS was not queued'
        );
      }
    } else {
      logger.warn(
        { bankTransactionId: String(current._id), estateId: String(current.estateId), tenantId: String(posted.tenant._id), reason: 'tenant_phone_missing' },
        'Bank payment posted but confirmation SMS was skipped because tenant phone is missing'
      );
    }

    return {
      matched: true,
      bankTransaction: posted.bankTransaction,
      payment: posted.payment,
      payments: posted.receiptPayments,
      creditPayments: posted.creditPayments,
      allocations: posted.allocations,
      summary: posted.summary,
    };
  },

  /**
   * Compatibility entry point used by transactionService.assignToHouse.
   * The caller first conditionally writes the manual MATCHED/POSTED state in
   * the same transaction; this method shares the same settlement engine.
   */
  async applyPayment({ bankTransaction, house, tenant, session, tenancyId = null, manualAssignment = false }) {
    if (!manualAssignment) {
      throw Errors.InvalidRequest('Direct Bank applyPayment requires the explicit manual-assignment ownership path');
    }
    const result = await applyBankReceipt({
      bankTransaction, house, tenant, session, tenancyId, manualAssignment: true,
    });
    return {
      payment: result.payment,
      payments: result.receiptPayments,
      creditPayments: result.creditPayments,
      allocations: result.allocations,
      remainingBalanceCents: result.remainingBalanceCents,
      summary: result.summary,
      reused: false,
    };
  },
};
