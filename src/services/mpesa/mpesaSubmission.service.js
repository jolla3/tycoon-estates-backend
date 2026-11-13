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
  const merchant = link && link.status === 'ACTIVE' ? await resolveOperationalMerchant(sub.clientId, sub.estateId) : null;
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
  const link = await MpesaSubmissionLink.findOne({ tokenDigest: digestToken(token), status: 'ACTIVE' });
  if (!link) return { accepted: false };

  const normalized = canonicalText(text);
  const digest = evidenceDigest(normalized);
  const existing = await MpesaSmsSubmission.findOne({
    clientId: link.clientId, estateId: link.estateId, tenantId: link.tenantId, evidenceDigest: digest,
  }).select('_id');
  if (existing) return { accepted: true };

  const parsed = parseMpesaSms(text);
  const _id = new mongoose.Types.ObjectId();
  const retain = env.G5_SMS_EVIDENCE_RETENTION_APPROVED === '1';
  const doc = {
    _id, clientId: link.clientId, estateId: link.estateId, tenantId: link.tenantId,
    linkId: link._id, linkVersion: link.linkVersion,
    state: parsed.ok ? SUBMISSION_STATE.PARSED : SUBMISSION_STATE.UNSUPPORTED,
    stateReason: parsed.ok ? null : parsed.errors[0] || 'unsupported',
    parserVersion: parsed.parserVersion, template: parsed.template, parseErrors: parsed.errors,
    evidenceDigest: digest,
  };
  if (parsed.ok) {
    Object.assign(doc, {
      receiptNumber: parsed.receiptNumber, amountCents: parsed.amountCents, currency: parsed.currency,
      smsMerchantName: parsed.merchantName, smsTransactionAt: parsed.transactionAt,
      timestampSemantics: parsed.timestampSemantics,
    });
  }
  if (retain) {
    const env1 = sealEnvelope(normalized, `g5sub:${_id}:${link.clientId}`);
    Object.assign(doc, { evidenceEnvelope: env1, evidenceKeyId: envelopeKeyId(env1), retentionState: 'RETAINED_ENCRYPTED' });
  }
  try {
    await MpesaSmsSubmission.create(doc);
  } catch (err) {
    if (err?.code === 11000) return { accepted: true }; // concurrent duplicate collapses
    throw err;
  }
  if (parsed.ok) {
    try { await matchSubmission(_id); } catch (err) { logger.warn({ code: err.code }, 'G5 matching deferred'); }
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
