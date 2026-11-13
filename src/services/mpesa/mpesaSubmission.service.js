// src/services/mpesa/mpesaSubmission.service.js
//
// Public Tenant SMS submission + matching against canonical Daraja receipts.
// The submitted SMS is EVIDENCE ONLY. It can never create money; posting requires a
// provider-verified canonical MpesaTransaction (see mpesaPosting.service.js).
// Payer MSISDN/name are neither parsed into storage nor compared with the Tenant.
import mongoose from 'mongoose';
import { MpesaSubmissionLink } from '../../models/MpesaSubmissionLink.js';
import { MpesaSmsSubmission, SUBMISSION_STATE } from '../../models/MpesaSmsSubmission.js';
import { MpesaTransaction } from '../../models/MpesaTransaction.js';
import { parseMpesaSms } from './mpesaSmsParser.js';
import { resolveOperationalMerchant } from './mpesaSubmissionLink.service.js';
import { evaluateEvidence, postVerifiedReceipt, postingGate } from './mpesaPosting.service.js';
import { DARAJA_PROVIDER } from './daraja.constants.js';
import { isWellFormedToken, digestToken } from '../../utils/g5Token.js';
import { sealEnvelope, envelopeKeyId, evidenceDigest } from '../../utils/g5Envelope.js';
import { env } from '../../config/environment.js';
import { logger } from '../../config/logger.js';

export const SUBMISSION_REJECTED = Symbol('SUBMISSION_REJECTED');

function canonicalText(text) {
  return String(text).replace(/\s+/g, ' ').trim();
}

/** Match one stored submission against the canonical receipt; never posts unless the gate is open. */
export async function matchSubmission(submissionId) {
  const sub = await MpesaSmsSubmission.findById(submissionId);
  if (!sub || ![SUBMISSION_STATE.PARSED, SUBMISSION_STATE.UNMATCHED].includes(sub.state)) return sub?.state || null;
  const link = await MpesaSubmissionLink.findById(sub.linkId);
  if (!link) return setState(sub, SUBMISSION_STATE.MANUAL_REVIEW, 'LINK_MISSING');
  // Merchant must still be operational for posting; link may already be rotated.
  const merchant = await resolveOperationalMerchant(sub.clientId, sub.estateId);
  if (!merchant) return setState(sub, SUBMISSION_STATE.UNMATCHED, 'MERCHANT_NOT_OPERATIONAL');
  const txn = await MpesaTransaction.findOne({
    provider: DARAJA_PROVIDER, businessShortCode: merchant.businessShortCode, receiptNumber: sub.receiptNumber,
  });
  if (!txn) return setState(sub, SUBMISSION_STATE.UNMATCHED, 'RECEIPT_NOT_YET_RECEIVED');
  const verdict = evaluateEvidence({ submission: sub, link, txn, profile: merchant });
  if (!verdict.ok) {
    const s = verdict.reason === 'COMPETING_CLAIM' ? SUBMISSION_STATE.CONFLICTING
      : verdict.reason === 'RECEIPT_NOT_VERIFIED' ? SUBMISSION_STATE.UNMATCHED : SUBMISSION_STATE.MANUAL_REVIEW;
    return setState(sub, s, verdict.reason, txn._id);
  }
  await setState(sub, SUBMISSION_STATE.MATCHED, null, txn._id);
  if (!(await postingGate())) {
    try {
      await postVerifiedReceipt({ submissionId: sub._id, clientId: sub.clientId, estateId: sub.estateId });
      return SUBMISSION_STATE.POSTED;
    } catch (err) {
      logger.warn({ code: err.code, submissionId: String(sub._id) }, 'G5 posting attempt did not complete');
    }
  }
  return SUBMISSION_STATE.MATCHED;
}

async function setState(sub, state, reason, txnId = null) {
  await MpesaSmsSubmission.updateOne(
    { _id: sub._id, state: { $in: [SUBMISSION_STATE.PARSED, SUBMISSION_STATE.UNMATCHED, SUBMISSION_STATE.MATCHED, SUBMISSION_STATE.RECEIVED] } },
    { $set: { state, stateReason: reason, ...(txnId ? { mpesaTransactionId: txnId } : {}) } }
  );
  return state;
}

/**
 * @returns {Promise<{accepted: boolean}>} Uniform result: unknown/revoked/malformed token and
 * disabled feature are indistinguishable to the caller.
 */
export async function submitSms({ token, text }) {
  if (env.G5_SUBMISSIONS_ENABLED !== '1' || !isWellFormedToken(token) || typeof text !== 'string') {
    return { accepted: false };
  }
  const tokenDigest = digestToken(token);
  // Pre-check without claiming acceptance — neutral rejection for unknown tokens.
  const probe = await MpesaSubmissionLink.findOne({ tokenDigest, status: 'ACTIVE' })
    .select('+tokenDigest');
  if (!probe) return { accepted: false };

  const normalized = canonicalText(text);
  const digest = evidenceDigest(normalized);
  // Fast path for already-accepted identical evidence (outside the write fence).
  const existing = await MpesaSmsSubmission.findOne({
    clientId: probe.clientId, estateId: probe.estateId, tenantId: probe.tenantId, evidenceDigest: digest,
  }).select('_id');
  if (existing) return { accepted: true };

  const parsed = parseMpesaSms(text);
  const retain = env.G5_SMS_EVIDENCE_RETENTION_APPROVED === '1';
  const submissionId = new mongoose.Types.ObjectId();

  const session = await mongoose.startSession();
  let accepted = false;
  let parseOk = parsed.ok;
  try {
    await session.withTransaction(async () => {
      // Re-check evidence uniqueness inside the transaction.
      const dup = await MpesaSmsSubmission.findOne({
        clientId: probe.clientId, estateId: probe.estateId, tenantId: probe.tenantId, evidenceDigest: digest,
      }).session(session).select('_id');
      if (dup) {
        accepted = true;
        return;
      }

      // Same-document write fence: ACTIVE + exact digest + exact linkVersion.
      // Rotation/revocation increment linkVersion / clear digest and will conflict.
      const now = new Date();
      const fenced = await MpesaSubmissionLink.findOneAndUpdate(
        {
          _id: probe._id,
          clientId: probe.clientId,
          estateId: probe.estateId,
          tenantId: probe.tenantId,
          tokenDigest,
          status: 'ACTIVE',
          linkVersion: probe.linkVersion,
        },
        { $inc: { submissionRevision: 1 } },
        { new: true, session }
      );
      if (!fenced) {
        // Link rotated/revoked between probe and fence — reject neutrally.
        accepted = false;
        return;
      }

      const doc = {
        _id: submissionId,
        clientId: fenced.clientId,
        estateId: fenced.estateId,
        tenantId: fenced.tenantId,
        linkId: fenced._id,
        linkVersion: fenced.linkVersion,
        acceptedLinkVersion: fenced.linkVersion,
        acceptedAt: now,
        state: parsed.ok ? SUBMISSION_STATE.PARSED : SUBMISSION_STATE.UNSUPPORTED,
        stateReason: parsed.ok ? null : (parsed.errors[0] || 'unsupported'),
        parserVersion: parsed.parserVersion,
        template: parsed.template,
        parseErrors: parsed.errors,
        evidenceDigest: digest,
      };
      if (parsed.ok) {
        Object.assign(doc, {
          receiptNumber: parsed.receiptNumber,
          amountCents: parsed.amountCents,
          currency: parsed.currency,
          smsMerchantName: parsed.merchantName,
          smsTransactionAt: parsed.transactionAt,
          timestampSemantics: parsed.timestampSemantics,
        });
      }
      if (retain) {
        const env1 = sealEnvelope(normalized, `g5sub:${submissionId}:${fenced.clientId}`);
        Object.assign(doc, {
          evidenceEnvelope: env1,
          evidenceKeyId: envelopeKeyId(env1),
          retentionState: 'RETAINED_ENCRYPTED',
        });
      }
      try {
        await MpesaSmsSubmission.create([doc], { session });
        accepted = true;
      } catch (err) {
        if (err?.code === 11000) {
          // Concurrent identical evidence; unique index is the final barrier.
          accepted = true;
          return;
        }
        throw err;
      }
    });
  } catch (err) {
    // Aborted session must not be reused for follow-up queries.
    if (err?.code === 11000) return { accepted: true };
    throw err;
  } finally {
    await session.endSession();
  }

  if (!accepted) return { accepted: false };
  if (parseOk) {
    try { await matchSubmission(submissionId); } catch (err) { logger.warn({ code: err.code }, 'G5 matching deferred'); }
  }
  return { accepted: true };
}

/** Background re-match for submissions that arrived before their canonical receipt. */
export async function matchPendingSubmissions(limit = 50) {
  const rows = await MpesaSmsSubmission.find({ state: { $in: [SUBMISSION_STATE.PARSED, SUBMISSION_STATE.UNMATCHED] } })
    .sort({ updatedAt: 1 }).limit(limit).select('_id');
  for (const r of rows) {
    try { await matchSubmission(r._id); } catch (err) { logger.warn({ code: err.code }, 'G5 re-match failed'); }
  }
  return rows.length;
}
