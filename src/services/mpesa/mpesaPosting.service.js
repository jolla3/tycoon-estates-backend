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
import { MpesaCollectionReference } from '../../models/MpesaCollectionReference.js';
import { Tenancy } from '../../models/Tenancy.js';
import { isActiveMapping } from './mpesaMerchantMapping.service.js';
import { AuditLog } from '../../models/AuditLog.js';
import { settleTenantAccount } from '../tenantCredit.service.js';
import { queueProtectedSms } from '../g5ProtectedSms.service.js';
import { Tenant } from '../../models/Tenant.js';
import { Estate } from '../../models/Estate.js';
import { TXN_VERIFICATION_STATE } from './daraja.constants.js';
import { inspectMpesaIndexes } from '../../utils/mpesaIndexReadiness.js';
import { assertPaymentReceiptIndexesAligned } from '../../utils/paymentReceiptIndexReadiness.js';
import { areFinancialIndexesReady } from '../../utils/ensureIndexes.js';
import { supportsMongoTransactions } from '../../config/database.js';
import { env } from '../../config/environment.js';
import { Errors } from '../../utils/errors.js';

export const POSTING_LEASE_MS = 60_000;
export const BUY_GOODS_TYPE = 'CustomerBuyGoodsOnline';
export const PAYBILL_TYPE = 'CustomerPayBillOnline';
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
export function evaluateEvidence({ submission, link, txn, profile, mappingActive = false }) {
  // A previously accepted submission remains processable after rotation/revocation.
  // Current ACTIVE status is required only for submissions that lack acceptance proof.
  if (!link) return { ok: false, reason: 'LINK_NOT_ACTIVE' };
  const hasAcceptanceProof = Boolean(submission?.acceptedAt && submission?.acceptedLinkVersion != null);
  if (!hasAcceptanceProof && link.status !== 'ACTIVE') return { ok: false, reason: 'LINK_NOT_ACTIVE' };
  if (hasAcceptanceProof) {
    if (String(link._id) !== String(submission.linkId)) return { ok: false, reason: 'LINK_IDENTITY_MISMATCH' };
    if (Number(submission.acceptedLinkVersion) !== Number(submission.linkVersion)) {
      return { ok: false, reason: 'ACCEPTANCE_VERSION_INCONSISTENT' };
    }
  }
  if (!profile || profile.operationalState !== 'ACTIVE') return { ok: false, reason: 'MERCHANT_NOT_OPERATIONAL' };
  if (String(profile.clientId) !== String(link.clientId)) return { ok: false, reason: 'MERCHANT_CLIENT_MISMATCH' };
  // Till SMS-evidence path only. A PayBill merchant never posts from tenant SMS evidence.
  if (profile.merchantType !== 'BUY_GOODS_TILL') return { ok: false, reason: 'NOT_TILL_MERCHANT' };
  // Authorization is an ACTIVE profile<->estate mapping (never the legacy profile.estateId).
  if (mappingActive !== true) return { ok: false, reason: 'MERCHANT_ESTATE_UNMAPPED' };
  if (link.merchantProfileId && String(link.merchantProfileId) !== String(profile._id)) {
    return { ok: false, reason: 'LINK_MERCHANT_MISMATCH' };
  }
  if (String(txn.merchantProfileId) !== String(profile._id) || String(txn.clientId) !== String(link.clientId)) {
    return { ok: false, reason: 'RECEIPT_SCOPE_MISMATCH' };
  }
  if (txn.transactionType !== BUY_GOODS_TYPE) return { ok: false, reason: 'NOT_BUY_GOODS' };
  if (txn.verificationState !== TXN_VERIFICATION_STATE.MATCHED) return { ok: false, reason: 'RECEIPT_NOT_VERIFIED' };
  if (txn.receiptNumber !== submission.receiptNumber) return { ok: false, reason: 'RECEIPT_NUMBER_MISMATCH' };
  if (submission.currency && txn.currency && String(txn.currency) !== String(submission.currency)) {
    return { ok: false, reason: 'CURRENCY_MISMATCH' };
  }
  // Canonical receipt fields AND the provider-accepted observation must both agree with the
  // submission; any divergence between them means the receipt is not settled and never posts.
  if (!Number.isSafeInteger(txn.amountCents) || txn.amountCents !== submission.amountCents
    || txn.acceptedAmountCents !== txn.amountCents) {
    return { ok: false, reason: 'AMOUNT_MISMATCH' };
  }
  const smsMs = new Date(submission.smsTransactionAt).getTime();
  const skew = Math.abs(new Date(txn.transactionAt).getTime() - smsMs);
  const acceptedSkew = Math.abs(new Date(txn.acceptedTransactionAt).getTime() - smsMs);
  if (!Number.isFinite(skew) || skew > TIMESTAMP_TOLERANCE_MS
    || !Number.isFinite(acceptedSkew) || acceptedSkew > TIMESTAMP_TOLERANCE_MS) {
    return { ok: false, reason: 'TIMESTAMP_OUT_OF_TOLERANCE' };
  }
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
  const mappingActive = await isActiveMapping({ merchantProfileId: profile?._id, clientId, estateId });
  const verdict = evaluateEvidence({ submission, link, txn, profile, mappingActive });
  if (!verdict.ok) {
    const state = verdict.reason === 'COMPETING_CLAIM' ? SUBMISSION_STATE.CONFLICTING : SUBMISSION_STATE.MANUAL_REVIEW;
    await MpesaSmsSubmission.updateOne(
      { _id: submission._id, state: { $nin: [SUBMISSION_STATE.POSTED, SUBMISSION_STATE.REJECTED] } },
      { $set: { state, stateReason: verdict.reason } }
    );
    throw Errors.Conflict(`Evidence rejected: ${verdict.reason}`);
  }

  return executeFencedPosting({
    txn, clientId, estateId, tenantId: submission.tenantId, actorUserId, ipAddress,
    evidence: { type: 'SMS_SUBMISSION', submission },
  });
}

/**
 * Pure evidence check for the PayBill reference path. Routing evidence only: the receipt must
 * still be provider-verified (MATCHED) and every existing posting safeguard applies.
 */
export function evaluateReferenceEvidence({ txn, reference, profile, mappingActive = false, tenancy }) {
  if (!reference) return { ok: false, reason: 'REFERENCE_NOT_FOUND' };
  if (reference.status !== 'ACTIVE') return { ok: false, reason: 'REFERENCE_RETIRED' };
  if (!profile || profile.operationalState !== 'ACTIVE') return { ok: false, reason: 'MERCHANT_NOT_OPERATIONAL' };
  if (profile.merchantType !== 'PAYBILL') return { ok: false, reason: 'NOT_PAYBILL_MERCHANT' };
  if (String(reference.merchantProfileId) !== String(profile._id)) return { ok: false, reason: 'REFERENCE_MERCHANT_MISMATCH' };
  if (String(reference.clientId) !== String(profile.clientId)) return { ok: false, reason: 'MERCHANT_CLIENT_MISMATCH' };
  if (mappingActive !== true) return { ok: false, reason: 'MERCHANT_ESTATE_UNMAPPED' };
  if (String(txn.merchantProfileId) !== String(profile._id) || String(txn.clientId) !== String(profile.clientId)) {
    return { ok: false, reason: 'RECEIPT_SCOPE_MISMATCH' };
  }
  if (txn.transactionType !== PAYBILL_TYPE) return { ok: false, reason: 'NOT_PAYBILL' };
  if (txn.verificationState !== TXN_VERIFICATION_STATE.MATCHED) return { ok: false, reason: 'RECEIPT_NOT_VERIFIED' };
  if (!Number.isSafeInteger(txn.amountCents) || txn.amountCents <= 0 || txn.acceptedAmountCents !== txn.amountCents) {
    return { ok: false, reason: 'AMOUNT_MISMATCH' };
  }
  if (!tenancy || String(tenancy._id) !== String(reference.tenancyId)
    || String(tenancy.tenantId) !== String(reference.tenantId)
    || String(tenancy.estateId) !== String(reference.estateId)
    || String(tenancy.clientId) !== String(reference.clientId)) {
    return { ok: false, reason: 'TENANCY_IDENTITY_MISMATCH' };
  }
  // Closed/void tenancies are not auto-posted; they go to review (G3 rules decide later).
  if (tenancy.status !== 'ACTIVE') return { ok: false, reason: 'TENANCY_NOT_ACTIVE' };
  if (txn.allocationReferenceId && String(txn.allocationReferenceId) !== String(reference._id)) {
    return { ok: false, reason: 'COMPETING_CLAIM' };
  }
  if (txn.attributedTenantId && String(txn.attributedTenantId) !== String(reference.tenantId)) {
    return { ok: false, reason: 'COMPETING_CLAIM' };
  }
  return { ok: true, reason: null };
}

/** Post one PayBill receipt that was allocated to exactly one reference. Same gates/fencing as Till. */
export async function postAllocatedReceipt({ transactionId, clientId, actorUserId = null, ipAddress = null }) {
  const blocked = await postingGate();
  if (blocked) throw Errors.ServiceUnavailable(`M-PESA posting blocked: ${blocked}`);
  const txn = await MpesaTransaction.findOne({ _id: transactionId, clientId });
  if (!txn || !txn.allocationReferenceId) throw Errors.NotFound('Allocated receipt not found');
  const reference = await MpesaCollectionReference.findOne({ _id: txn.allocationReferenceId, clientId });
  const profile = await MpesaMerchantProfile.findOne({ _id: txn.merchantProfileId, clientId });
  const tenancy = reference ? await Tenancy.findOne({ _id: reference.tenancyId, clientId }) : null;
  const mappingActive = reference
    ? await isActiveMapping({ merchantProfileId: profile?._id, clientId, estateId: reference.estateId })
    : false;
  const verdict = evaluateReferenceEvidence({ txn, reference, profile, mappingActive, tenancy });
  if (!verdict.ok) {
    await MpesaTransaction.updateOne(
      { _id: txn._id, postingState: { $ne: 'POSTED' } },
      { $set: { claimState: 'REVIEW', allocationReason: verdict.reason } }
    );
    throw Errors.Conflict(`Evidence rejected: ${verdict.reason}`);
  }
  return executeFencedPosting({
    txn, clientId, estateId: reference.estateId, tenantId: reference.tenantId, actorUserId, ipAddress,
    evidence: { type: 'PAYBILL_REFERENCE', reference },
  });
}

/** Exported ONLY so replica-set tests can exercise the fence beneath postingGate(); never call from app code. */
export async function executeFencedPosting({ txn, clientId, estateId, tenantId, actorUserId, ipAddress, evidence }) {
  const submission = evidence.type === 'SMS_SUBMISSION' ? evidence.submission : null;
  // Already fully posted receipt: never a second Payment.
  if (txn.postingState === 'POSTED') {
    if (String(txn.attributedTenantId) !== String(tenantId)) throw Errors.Conflict('Receipt already posted to another Tenant');
    return { reused: true, paymentIds: txn.paymentIds };
  }

  // Write-bearing conditional claim + fencing token.
  const token = crypto.randomBytes(24).toString('hex');
  const now = new Date();
  const claimed = await MpesaTransaction.findOneAndUpdate(
    {
      _id: txn._id,
      $and: [
        { $or: [{ attributedTenantId: null }, { attributedTenantId: tenantId }] },
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
        attributedTenantId: tenantId,
        ...(submission ? { attributedSubmissionId: submission._id } : {}),
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
        clientId, estateId, tenantId,
        receipt: {
          transactionId: txn._id, receiptNumber: txn.receiptNumber,
          amountCents: txn.amountCents, transactionAt: txn.transactionAt,
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

      if (submission) {
        const sub = await MpesaSmsSubmission.updateOne(
          { _id: submission._id, clientId, estateId, state: { $ne: SUBMISSION_STATE.POSTED } },
          { $set: { state: SUBMISSION_STATE.POSTED, stateReason: null } },
          { session }
        );
        if (sub.matchedCount !== 1) throw Errors.Conflict('Submission state changed; aborting');
      }

      // Confirmation follows the validated canonical receipt attribution, not the
      // Tenant's mutable current estate pointer (tenants can transfer after payment).
      const tenant = await Tenant.findOne({ _id: tenantId, clientId }).session(session).select('phone');
      const estate = await Estate.findOne({ _id: estateId, clientId }).session(session).select('name');
      const phone = tenant?.phone && String(tenant.phone).trim();
      if (phone && estate?.name) {
        if (!Number.isSafeInteger(txn.amountCents) || txn.amountCents <= 0) {
          throw Errors.Conflict('Canonical M-PESA receipt amount is invalid for confirmation');
        }
        const currency = txn.currency || 'KES';
        const amount = (Number(txn.amountCents) / 100).toFixed(2);
        const body = estate.name + ': M-PESA receipt ' + txn.receiptNumber + ' of ' + currency + ' ' + amount + ' has been applied to your rent account.';
        await queueProtectedSms({
          clientId, estateId, tenantId,
          phone, body, type: 'payment_confirmation',
          notificationVersion: 'payment_confirmation:v1',
          idempotencyKey: 'confirm:' + String(txn._id) + ':' + String(tenantId),
          session,
        });
      } else {
        const reason = !tenant ? 'tenant_not_found'
          : !phone ? 'tenant_phone_missing' : 'estate_identity_unavailable';
        await AuditLog.create([{
          clientId, estateId, userId: actorUserId || undefined,
          action: 'G5_CONFIRMATION_SMS_BLOCKED', resource: 'MpesaTransaction', resourceId: txn._id,
          description: 'Payment confirmation SMS not queued because canonical tenant or estate identity was unavailable',
          metadata: { tenantId: String(tenantId), reason },
          ipAddress,
        }], { session });
      }

      await AuditLog.create([{
        clientId, estateId, userId: actorUserId || undefined,
        action: 'MPESA_RECEIPT_POSTED', resource: 'MpesaTransaction', resourceId: txn._id,
        description: 'Verified M-PESA receipt posted to G3',
        metadata: {
          tenantId: String(tenantId), evidenceType: evidence.type,
          ...(submission ? { submissionId: String(submission._id) } : { referenceId: String(evidence.reference._id) }),
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
