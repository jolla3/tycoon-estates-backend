// src/services/reconciliation.service.js
//
// Bank-agnostic (section 12/19). Only ever consumes the normalized
// BankTransaction shape — has no idea which bank produced it. Never
// guesses: anything it can't confidently match stays UNMATCHED for
// manual admin review (transaction.service.js exposes that path).
//
// clientId flows through from the BankTransaction itself (which the
// webhook/sync path already set from BankAccount.clientId) — this
// service never re-derives or trusts a clientId from anywhere else,
// which is what makes cross-client house matching structurally
// impossible: findHouseByReference always filters by the transaction's
// own clientId.
//
// FINANCIAL ATOMICITY: applyPayment() writes Payment + RentCharge +
// BankTransaction (matchStatus) together inside a MongoDB session
// transaction — a crash between the Payment write and the RentCharge
// write can no longer leave a payment recorded against a stale balance.
// This requires a replica-set (or sharded) MongoDB deployment; a
// standalone mongod does not support multi-document transactions. See
// README "Database Requirements".

import mongoose from 'mongoose';
import { House } from '../models/House.js';
import { Tenant } from '../models/Tenant.js';
import { Payment } from '../models/Payment.js';
import { BankTransaction } from '../models/BankTransaction.js';
import { rentService } from './rent.service.js';
import { smsService } from './sms.service.js';
import { dateUtil } from '../utils/date.js';
import { escapeRegex } from '../utils/regex.js';
import { logger } from '../config/logger.js';
import { audit } from './audit.service.js';
import { tenancyContains, tenancyService } from './tenancy.service.js';
import { accountingPostingService } from './accountingPosting.service.js';
import { Tenancy } from '../models/Tenancy.js';
import { Errors } from '../utils/errors.js';

/**
 * Matching hierarchy — exact matches only, in this order, never a fuzzy
 * guess:
 *   1. Reference matches House.houseNumber exactly (case-insensitive).
 *   2. Reference matches one of House.paymentReferences (admin-configured
 *      aliases — e.g. a tenant account number that differs from the
 *      house number).
 *   3. UNMATCHED — left for manual admin review.
 *
 * Both steps are scoped to the transaction's clientId — a reference that
 * happens to also match some OTHER client's house number can never be
 * matched to it. Read-only, so it runs outside any transaction.
 */
async function findHouseByReference(clientId, estateId, reference) {
  if (!reference) return null;
  const pattern = new RegExp(`^${escapeRegex(reference)}$`, 'i');
  const scope = { clientId, isActive: true };
  if (estateId) scope.estateId = estateId;
  const byHouseNumber = await House.findOne({ ...scope, houseNumber: pattern });
  if (byHouseNumber) return byHouseNumber;
  return House.findOne({ ...scope, paymentReferences: pattern });
}


const sameId = (a, b) => a != null && b != null && String(a) === String(b);

/**
 * Consume a G4 processing claim inside the same MongoDB transaction as
 * the financial writes. This conditional write is the ownership fence:
 * takeover and posting must contend on the same BankTransaction document.
 */
async function consumeG4ClaimInTransaction(bankTransaction, claimToken, session, fields = {}) {
  if (!session) {
    throw new Error('G4 claim consumption requires the G3 MongoDB transaction');
  }

  const now = new Date();
  const committedFields = {
    ...fields,
    processingState: 'POSTED',
    processingClaimToken: null,
    processingClaimExpiresAt: null,
    lastProcessingError: null,
  };

  const result = await BankTransaction.updateOne(
    {
      _id: bankTransaction._id,
      processingState: 'CLAIMED',
      processingClaimToken: claimToken,
      processingClaimExpiresAt: { $gt: now },
    },
    { $set: committedFields },
    { session }
  );

  if (result.matchedCount !== 1) {
    throw Errors.Conflict(
      'Bank transaction processing claim is expired, missing, or no longer owned'
    );
  }

  Object.assign(bankTransaction, committedFields);
}

/**
 * Atomically move a claimed transaction to manual review.
 * Unlike financial posting, this transition has no multi-document effects,
 * so one conditional update is the complete ownership boundary.
 */
async function markG4ClaimManualReview(bankTransaction, claimToken, fields = {}) {
  const now = new Date();
  const reviewFields = {
    lastProcessingError: null,
    ...fields,
    processingState: 'MANUAL_REVIEW',
    processingClaimToken: null,
    processingClaimExpiresAt: null,
  };

  const result = await BankTransaction.updateOne(
    {
      _id: bankTransaction._id,
      processingState: 'CLAIMED',
      processingClaimToken: claimToken,
      processingClaimExpiresAt: { $gt: now },
    },
    { $set: reviewFields }
  );

  if (result.matchedCount !== 1) {
    throw Errors.Conflict(
      'Bank transaction processing claim is expired, missing, or no longer owned'
    );
  }

  Object.assign(bankTransaction, reviewFields);
}

export const reconciliationService = {
  async reconcile(bankTransaction, options = {}) {
    const claimToken = options?.claimToken;
    const hasClaimToken = claimToken !== undefined && claimToken !== null;

    if (hasClaimToken && (typeof claimToken !== 'string' || !claimToken.trim())) {
      throw Errors.InvalidRequest('A non-empty G4 processing claim token is required');
    }
    if (bankTransaction.eventType !== 'CREDIT') {
      if (bankTransaction.matchStatus === 'MATCHED') {
        throw Errors.Conflict('MATCHED BankTransaction is not a CREDIT; manual financial review required');
      }

      const reviewFields = {
        matchStatus: 'UNMATCHED',
        lastProcessingError: 'Only CREDIT bank transactions can be applied as payments',
      };

      if (hasClaimToken) {
        await markG4ClaimManualReview(bankTransaction, claimToken, reviewFields);
      } else {
        Object.assign(bankTransaction, reviewFields, { processingState: 'MANUAL_REVIEW' });
        await bankTransaction.save();
      }

      return { matched: false, bankTransaction, reason: 'not_a_credit' };
    }
    if (!Number.isSafeInteger(bankTransaction.amountCents) || bankTransaction.amountCents <= 0) {
      throw Errors.InvalidRequest('Bank transaction amountCents must be a positive safe integer');
    }

    // A previously MATCHED row is not trusted as proof that all financial
    // side-effects are intact. Re-enter the canonical idempotent posting path
    // so a missing PAYMENT Ledger row can be repaired and scope drift rejected.
    if (bankTransaction.matchStatus === 'MATCHED') {
      const existingPayment = await Payment.findOne({
        clientId: bankTransaction.clientId,
        origin: 'BANK',
        bankTransactionId: bankTransaction._id,
        status: 'CONFIRMED',
      }).lean();
      if (!existingPayment) {
        throw Errors.Conflict('MATCHED BankTransaction has no confirmed linked Payment; manual financial review required');
      }
      if (!bankTransaction.matchedHouseId || !bankTransaction.matchedTenancyId) {
        throw Errors.Conflict('MATCHED BankTransaction is missing its House/Tenancy identity; automatic attribution is unsafe');
      }
      const tenancy = await Tenancy.findOne({
        _id: bankTransaction.matchedTenancyId,
        clientId: bankTransaction.clientId,
        estateId: bankTransaction.estateId,
        houseId: bankTransaction.matchedHouseId,
        ...(bankTransaction.matchedTenantId ? { tenantId: bankTransaction.matchedTenantId } : {}),
      }).lean();
      if (!tenancy || !bankTransaction.matchedTenantId
        || !sameId(tenancy.tenantId, bankTransaction.matchedTenantId)) {
        throw Errors.Conflict('MATCHED BankTransaction Tenancy ownership does not match its stored match identity');
      }
      const tenancyAtPaymentDate = await tenancyService.findUniqueForHouseAt(
        bankTransaction.clientId, bankTransaction.matchedHouseId, bankTransaction.transactionDate
      );
      if (!tenancyAtPaymentDate || !sameId(tenancyAtPaymentDate._id, tenancy._id)) {
        throw Errors.Conflict('MATCHED BankTransaction date no longer resolves to its stored Tenancy');
      }
      const tenant = await Tenant.findOne({
        _id: tenancy.tenantId,
        clientId: bankTransaction.clientId,
      }).lean();
      if (!tenant) throw Errors.Conflict('MATCHED BankTransaction references a missing or out-of-scope Tenant');

      const session = await mongoose.startSession();
      let repaired;
      try {
        await session.withTransaction(async () => {
          // Serialize against close/move operations and revalidate the historical
          // occupancy interval inside the same transaction as the retry repair.
          const tenancyLock = await Tenancy.updateOne(
            {
              _id: tenancy._id,
              clientId: bankTransaction.clientId,
              estateId: bankTransaction.estateId,
              houseId: bankTransaction.matchedHouseId,
              tenantId: bankTransaction.matchedTenantId,
            },
            { $inc: { ledgerRev: 1 } },
            { session }
          );
          if (tenancyLock.matchedCount !== 1) {
            throw Errors.Conflict('MATCHED BankTransaction Tenancy changed during retry');
          }
          const tenancyInTransaction = await Tenancy.findOne({
            _id: tenancy._id,
            clientId: bankTransaction.clientId,
            estateId: bankTransaction.estateId,
            houseId: bankTransaction.matchedHouseId,
            tenantId: bankTransaction.matchedTenantId,
          }).session(session).lean();
          if (!tenancyInTransaction || !tenancyContains(tenancyInTransaction, bankTransaction.transactionDate)) {
            throw Errors.Conflict('MATCHED BankTransaction date is outside its historical Tenancy');
          }
          repaired = await accountingPostingService.postConfirmedPayment({
            clientId: bankTransaction.clientId,
            estateId: bankTransaction.estateId,
            houseId: bankTransaction.matchedHouseId,
            tenantId: tenancy.tenantId,
            tenancyId: tenancy._id,
            amountCents: bankTransaction.amountCents,
            paymentDate: bankTransaction.transactionDate,
            paymentReference: bankTransaction.paymentReference || null,
            period: dateUtil.periodOf(bankTransaction.transactionDate),
            origin: 'BANK',
            bankTransactionId: bankTransaction._id,
            charges: [],
          }, { session });
          if (hasClaimToken) {
            await consumeG4ClaimInTransaction(bankTransaction, claimToken, session);
          } else {
            bankTransaction.processingState = 'POSTED';
            bankTransaction.lastProcessingError = null;
            await bankTransaction.save({ session });
          }
        });
      } finally {
        await session.endSession();
      }
      return {
        matched: true,
        reused: true,
        bankTransaction,
        payment: repaired.payment,
        allocations: repaired.allocations,
      };
    }

    const reference = (bankTransaction.paymentReference || bankTransaction.narration || '').trim();
    const clientId = bankTransaction.clientId;
    const estateId = bankTransaction.estateId;

    const house = await findHouseByReference(clientId, estateId, reference);
    if (!house) {
      if (hasClaimToken) {
        await markG4ClaimManualReview(bankTransaction, claimToken, {
          matchStatus: 'UNMATCHED',
        });
      } else {
        bankTransaction.matchStatus = 'UNMATCHED';
        bankTransaction.processingState = 'MANUAL_REVIEW';
        await bankTransaction.save();
      }

      logger.warn({ clientId: String(clientId), reference, transactionId: bankTransaction.providerTransactionId }, 'Bank transaction could not be matched to a house');
      return { matched: false, bankTransaction };
    }

    const tenancy = await tenancyService.findUniqueForHouseAt(clientId, house._id, bankTransaction.transactionDate);
    if (!tenancy) {
      const reviewFields = {
        matchStatus: 'UNMATCHED',
        matchedHouseId: house._id,
      };

      if (hasClaimToken) {
        await markG4ClaimManualReview(bankTransaction, claimToken, reviewFields);
      } else {
        Object.assign(bankTransaction, reviewFields, { processingState: 'MANUAL_REVIEW' });
        await bankTransaction.save();
      }

      return { matched: false, bankTransaction, reason: 'no_unique_tenancy' };
    }

    if (!sameId(tenancy.estateId, house.estateId) || !sameId(tenancy.houseId, house._id)) {
      throw Errors.Conflict('Resolved Tenancy does not belong to the matched House/Estate');
    }
    // Tenant.houseId/estateId are mutable current-location fields. Historical
    // ownership is established by the immutable Tenancy resolved above.
    const tenant = await Tenant.findOne({
      _id: tenancy.tenantId,
      clientId,
    });
    if (!tenant) throw Errors.TenantNotFound();
    const period = dateUtil.periodOf(bankTransaction.transactionDate);

    const session = await mongoose.startSession();
    let payment, allocations, remainingBalanceCents;
    try {
      await session.withTransaction(async () => {
        const result = await this.applyPayment({
          bankTransaction,
          house,
          tenant,
          period,
          session,
          tenancyId: tenancy._id,
        });
        payment = result.payment;
        allocations = result.allocations;
        remainingBalanceCents = result.remainingBalanceCents;

        if (hasClaimToken) {
          await consumeG4ClaimInTransaction(bankTransaction, claimToken, session, {
            matchedHouseId: house._id,
            matchedTenantId: tenant?._id || null,
            matchedTenancyId: tenancy._id,
            matchStatus: 'MATCHED',
          });
        } else {
          bankTransaction.matchedHouseId = house._id;
          bankTransaction.matchedTenantId = tenant?._id || null;
          bankTransaction.matchedTenancyId = tenancy._id;
          bankTransaction.matchStatus = 'MATCHED';
          bankTransaction.processingState = 'POSTED';
          bankTransaction.lastProcessingError = null;
          await bankTransaction.save({ session });
        }
      });
    } finally {
      await session.endSession();
    }

    // Deliberately OUTSIDE the financial transaction and only reached if
    // it committed successfully.
    await audit({
      clientId: bankTransaction.clientId,
      estateId: house.estateId,
      action: 'PAYMENT_RECONCILED',
      resource: 'Payment',
      resourceId: payment?._id,
      metadata: {
        bankTransactionId: String(bankTransaction._id),
        houseId: String(house._id),
        amountCents: bankTransaction.amountCents,
        allocations: (allocations || []).length,
      },
    });
    for (const a of allocations || []) {
      await audit({
        clientId: bankTransaction.clientId,
        estateId: house.estateId,
        action: 'PAYMENT_ALLOCATED',
        resource: 'PaymentAllocation',
        resourceId: a.rentChargeId,
        metadata: {
          paymentId: String(payment?._id),
          amountCents: a.amountCents,
          chargeType: a.chargeType,
          period: a.period,
        },
      });
    }

    if (tenant?.phone) {
      await smsService.sendPaymentConfirmation({
        clientId: bankTransaction.clientId,
        estateId: house.estateId,
        tenantId: tenant._id,
        houseId: house._id,
        phone: tenant.phone,
        tenantName: tenant.name,
        houseNumber: house.houseNumber,
        amountCents: bankTransaction.amountCents,
        balanceCents: Math.max(remainingBalanceCents ?? 0, 0),
      });
    }

    return { matched: true, house, payment, allocations };
  },

  /**
   * Creates the Payment and updates the RentCharge atomically (same
   * session/transaction as the caller). Shared by both the automatic
   * reconcile() path and the manual "assign UNMATCHED transaction" admin
   * path (transaction.service.js#assignToHouse) — both open their own
   * session and pass it through here, and both are responsible for
   * sending any post-commit notification themselves (see the comment in
   * reconcile() above for why that must stay outside the transaction).
   */
  /**
   * Atomic payment + multi-charge allocation (oldest outstanding first).
   * Accepts either `charges` (preferred) or a single `rentCharge` (legacy).
   */
  async applyPayment({ bankTransaction, house, tenant, period, session, tenancyId = null }) {
    if (!session) {
      throw new Error('applyPayment requires a MongoDB session from the caller');
    }
    if (!tenancyId) {
      throw Errors.InvalidRequest('tenancyId is required for bank payment application');
    }
    if (bankTransaction?.eventType !== 'CREDIT') {
      throw Errors.InvalidRequest('Only CREDIT bank transactions can be applied as payments');
    }
    if (!Number.isSafeInteger(bankTransaction.amountCents) || bankTransaction.amountCents <= 0) {
      throw Errors.InvalidRequest('Bank transaction amountCents must be a positive safe integer');
    }
    if (!sameId(bankTransaction.clientId, house?.clientId)
      || !sameId(bankTransaction.estateId, house?.estateId)) {
      throw Errors.Conflict('BankTransaction and House client/estate scope mismatch');
    }
    const tenancyScope = {
      _id: tenancyId,
      clientId: bankTransaction.clientId,
      estateId: house.estateId,
      houseId: house._id,
      tenantId: tenant?._id,
    };
    // This shared write point conflicts with concurrent tenancy close/move
    // transactions. The interval is then checked against the bank's value date.
    const tenancyLock = await Tenancy.updateOne(
      tenancyScope,
      { $inc: { ledgerRev: 1 } },
      { session }
    );
    if (tenancyLock.matchedCount !== 1) {
      throw Errors.Conflict('Bank payment Tenant does not match the exact Tenancy');
    }
    const tenancy = await Tenancy.findOne(tenancyScope).session(session).lean();
    if (!tenancy || !tenancyContains(tenancy, bankTransaction.transactionDate)) {
      throw Errors.Conflict('Bank transaction date is outside the exact historical Tenancy');
    }
    // Ensure current-period charges for THIS tenancy only (never house-wide personal fallback)
    await rentService.ensureChargesForHouse(
      bankTransaction.clientId,
      house,
      tenant,
      period,
      { session, tenancyId }
    );
    const outstanding = await rentService.outstandingChargesForTenancy(
      bankTransaction.clientId,
      tenancyId,
      { session }
    );
    const posted = await accountingPostingService.postConfirmedPayment({
      clientId: bankTransaction.clientId,
      estateId: house.estateId,
      houseId: house._id,
      tenantId: tenant?._id || null,
      tenancyId,
      amountCents: bankTransaction.amountCents,
      paymentDate: bankTransaction.transactionDate,
      paymentReference: bankTransaction.paymentReference || null,
      period: period || null,
      origin: 'BANK',
      bankTransactionId: bankTransaction._id,
      charges: outstanding,
    }, { session });
    return {
      payment: posted.payment,
      allocations: posted.allocations,
      remainingBalanceCents: posted.remainingBalanceCents,
      reused: posted.reused,
    };
  },

};
