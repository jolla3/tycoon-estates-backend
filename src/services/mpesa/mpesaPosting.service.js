// src/services/mpesa/mpesaPosting.service.js
//
// G5 — post ONE provider-verified canonical receipt to G3 for ONE Tenant.
//
// Fail-closed gates (all must hold, re-checked per call):
//   env G5_MPESA_POSTING_ENABLED, MongoDB transactions, financial indexes,
//   canonical receipt identity (B01/B02), Payment receipt/credit indexes aligned.
// Concurrency: write-bearing conditional claim with random fencing token + expiry
//   on MpesaTransaction. The FINAL step inside the Mongo transaction is a conditional
//   update requiring the same token and an unexpired lease; a stale worker matches
//   nothing, throws, and the whole transaction aborts (no Payment survives).
// Attribution: attributed* fields are set only while null (first claim wins).

import crypto from 'crypto';
import mongoose from 'mongoose';
import { MpesaTransaction } from '../../models/MpesaTransaction.js';
import { MpesaSmsSubmission, SUBMISSION_STATE } from '../../models/MpesaSmsSubmission.js';
import { MpesaSubmissionLink } from '../../models/MpesaSubmissionLink.js';
import { MpesaMerchantProfile } from '../../models/MpesaMerchantProfile.js';
import { AuditLog } from '../../models/AuditLog.js';
import { settleTenantAccount } from '../tenantCredit.service.js';
import { TXN_VERIFICATION_STATE } from './daraja.constants.js';
import { inspectMpesaIndexes } from '../../utils/mpesaIndexReadiness.js';
import { assertPaymentReceiptIndexesAligned } from '../../utils/paymentReceiptIndexReadiness.js';
import { areFinancialIndexesReady } from '../../utils/ensureIndexes.js';
import { supportsMongoTransactions } from '../../config/database.js';
import { env } from '../../config/environment.js';
import { Errors } from '../../utils/errors.js';

export const POSTING_LEASE_MS = 60_000;
export const BUY_GOODS_TYPE = 'CustomerBuyGoodsOnline';
export const TIMESTAMP_TOLERANCE_MS = 10 * 60 * 1000; // parser minute precision + clock skew; tune only with B04 evidence

export const POSTING_BLOCK = Object.freeze({
  DISABLED: 'POSTING_DISABLED',
  NO_TX: 'TRANSACTIONS_UNAVAILABLE',
  FIN_INDEX: 'FINANCIAL_INDEXES_NOT_READY',
  RECEIPT_IDENTITY: 'CANONICAL_RECEIPT_IDENTITY_NOT_PROVEN',
  PAYMENT_INDEX: 'PAYMENT_RECEIPT_INDEXES_NOT_ALIGNED',
});

export async function postingGate() {
  if (env.G5_MPESA_POSTING_ENABLED !== '1') return POSTING_BLOCK.DISABLED;
  if (supportsMongoTransactions() !== true) return POSTING_BLOCK.NO_TX;
  if (!areFinancialIndexesReady()) return POSTING_BLOCK.FIN_INDEX;
  const report = await inspectMpesaIndexes();
  if (report.gates.canonicalReceiptIdentity !== true) return POSTING_BLOCK.RECEIPT_IDENTITY;
  try { await assertPaymentReceiptIndexesAligned(); } catch { return POSTING_BLOCK.PAYMENT_INDEX; }
  return null;
}

/**
 * Pure evidence check: does submission evidence agree with the canonical receipt and link scope?
 * Returns { ok, reason }. Never compares payer MSISDN/name to the Tenant.
 */
export function evaluateEvidence({ submission, link, txn, profile }) {
  if (!link || link.status !== 'ACTIVE') return { ok: false, reason: 'LINK_NOT_ACTIVE' };
  if (!profile || profile.operationalState !== 'ACTIVE') return { ok: false, reason: 'MERCHANT_NOT_OPERATIONAL' };
  if (String(profile.clientId) !== String(link.clientId)) return { ok: false, reason: 'MERCHANT_CLIENT_MISMATCH' };
  if (!profile.estateId || String(profile.estateId) !== String(link.estateId)) return { ok: false, reason: 'MERCHANT_ESTATE_UNMAPPED' };
  if (String(txn.merchantProfileId) !== String(profile._id) || String(txn.clientId) !== String(link.clientId)) {
    return { ok: false, reason: 'RECEIPT_SCOPE_MISMATCH' };
  }
  if (txn.transactionType !== BUY_GOODS_TYPE) return { ok: false, reason: 'NOT_BUY_GOODS' };
  if (txn.verificationState !== TXN_VERIFICATION_STATE.MATCHED) return { ok: false, reason: 'RECEIPT_NOT_VERIFIED' };
  if (txn.receiptNumber !== submission.receiptNumber) return { ok: false, reason: 'RECEIPT_NUMBER_MISMATCH' };
  if (!Number.isSafeInteger(txn.acceptedAmountCents) || txn.acceptedAmountCents !== submission.amountCents) {
    return { ok: false, reason: 'AMOUNT_MISMATCH' };
  }
  const skew = Math.abs(new Date(txn.acceptedTransactionAt).getTime() - new Date(submission.smsTransactionAt).getTime());
  if (!Number.isFinite(skew) || skew > TIMESTAMP_TOLERANCE_MS) return { ok: false, reason: 'TIMESTAMP_OUT_OF_TOLERANCE' };
  if (txn.attributedTenantId && String(txn.attributedTenantId) !== String(submission.tenantId)) {
    return { ok: false, reason: 'COMPETING_CLAIM' };
  }
  return { ok: true, reason: null };
}

export async function postVerifiedReceipt({ submissionId, clientId, estateId, actorUserId = null, ipAddress = null }) {
  const blocked = await postingGate();
  if (blocked) throw Errors.ServiceUnavailable(`M-PESA posting blocked: ${blocked}`);

  const submission = await MpesaSmsSubmission.findOne({ _id: submissionId, clientId, estateId });
  if (!submission || !submission.mpesaTransactionId) throw Errors.NotFound('Submission not found');
  if (submission.state === SUBMISSION_STATE.POSTED) return { reused: true, submissionId: submission._id };
  const link = await MpesaSubmissionLink.findOne({ _id: submission.linkId, clientId, estateId, tenantId: submission.tenantId });
  const txn = await MpesaTransaction.findById(submission.mpesaTransactionId);
  if (!txn) throw Errors.NotFound('Receipt not found');
  const profile = await MpesaMerchantProfile.findOne({ _id: txn.merchantProfileId, clientId });
  const verdict = evaluateEvidence({ submission, link, txn, profile });
  if (!verdict.ok) {
    const state = verdict.reason === 'COMPETING_CLAIM' ? SUBMISSION_STATE.CONFLICTING : SUBMISSION_STATE.MANUAL_REVIEW;
    await MpesaSmsSubmission.updateOne(
      { _id: submission._id, state: { $nin: [SUBMISSION_STATE.POSTED, SUBMISSION_STATE.REJECTED] } },
      { $set: { state, stateReason: verdict.reason } }
    );
    throw Errors.Conflict(`Evidence rejected: ${verdict.reason}`);
  }

  // Already fully posted receipt: never a second Payment.
  if (txn.postingState === 'POSTED') {
    if (String(txn.attributedTenantId) !== String(submission.tenantId)) throw Errors.Conflict('Receipt already posted to another Tenant');
    return { reused: true, paymentIds: txn.paymentIds };
  }

  // Write-bearing conditional claim + fencing token.
  const token = crypto.randomBytes(24).toString('hex');
  const now = new Date();
  const claimed = await MpesaTransaction.findOneAndUpdate(
    {
      _id: txn._id,
      $and: [
        { $or: [{ attributedTenantId: null }, { attributedTenantId: submission.tenantId }] },
        { $or: [
          { postingState: { $in: ['NOT_POSTED', 'FAILED_RETRYABLE'] } },
          { postingState: 'PROCESSING', postingLeaseExpiresAt: { $lte: now } },
        ] },
      ],
    },
    {
      $set: {
        postingState: 'PROCESSING', postingLeaseToken: token,
        postingLeaseExpiresAt: new Date(now.getTime() + POSTING_LEASE_MS),
        attributedClientId: clientId, attributedEstateId: estateId,
        attributedTenantId: submission.tenantId, attributedSubmissionId: submission._id,
        claimState: 'CLAIMED',
      },
      $inc: { postingAttempts: 1 },
    },
    { new: true }
  );
  if (!claimed) throw Errors.Conflict('Receipt is being processed or claimed elsewhere');

  const session = await mongoose.startSession();
  try {
    let result;
    await session.withTransaction(async () => {
      const settled = await settleTenantAccount({
        clientId, estateId, tenantId: submission.tenantId,
        receipt: {
          transactionId: txn._id, receiptNumber: txn.receiptNumber,
          amountCents: txn.acceptedAmountCents, transactionAt: txn.acceptedTransactionAt,
        },
        session,
      });
      const paymentIds = settled.receiptPayments.map((p) => p._id);

      // FENCED finalize: matches only while this attempt still owns an unexpired lease.
      const fin = await MpesaTransaction.updateOne(
        { _id: txn._id, postingLeaseToken: token, postingState: 'PROCESSING', postingLeaseExpiresAt: { $gt: new Date() } },
        {
          $set: {
            postingState: 'POSTED', postedAt: new Date(), paymentIds,
            paymentId: paymentIds[0] || null,
            creditEarnedCents: settled.plan.newCreditCents,
            postingLeaseToken: null, postingLeaseExpiresAt: null, postingFailureCode: null,
          },
        },
        { session }
      );
      if (fin.matchedCount !== 1) throw Errors.Conflict('Posting lease lost; aborting');

      const sub = await MpesaSmsSubmission.updateOne(
        { _id: submission._id, clientId, estateId, state: { $ne: SUBMISSION_STATE.POSTED } },
        { $set: { state: SUBMISSION_STATE.POSTED, stateReason: null } },
        { session }
      );
      if (sub.matchedCount !== 1) throw Errors.Conflict('Submission state changed; aborting');

      await AuditLog.create([{
        clientId, estateId, userId: actorUserId || undefined,
        action: 'MPESA_RECEIPT_POSTED', resource: 'MpesaTransaction', resourceId: txn._id,
        description: 'Verified M-PESA receipt posted to G3',
        metadata: {
          tenantId: String(submission.tenantId), submissionId: String(submission._id),
          paymentIds: paymentIds.map(String),
          receiptAppliedCents: settled.plan.receiptAppliedCents,
          creditAppliedCents: settled.plan.creditAppliedCents,
          newCreditCents: settled.plan.newCreditCents,
        },
        ipAddress,
      }], { session });
      result = { paymentIds, ...settled.plan };
    });
    return { reused: false, ...result };
  } catch (err) {
    // Release only if we still own the lease; never touch a newer owner's claim.
    await MpesaTransaction.updateOne(
      { _id: txn._id, postingLeaseToken: token, postingState: 'PROCESSING' },
      { $set: { postingState: 'FAILED_RETRYABLE', postingFailureCode: String(err.code || 'POSTING_ERROR').slice(0, 64),
        postingLeaseToken: null, postingLeaseExpiresAt: null } }
    ).catch(() => {});
    throw err;
  } finally {
    await session.endSession();
  }
}
