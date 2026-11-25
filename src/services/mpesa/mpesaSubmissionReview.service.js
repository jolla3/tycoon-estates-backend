// Admin review of submissions. Conditional, audited transitions only.
// No operation here can create a Payment; posting happens only via mpesaPosting.service
// after evidence agreement. B10 (override policy) is unresolved, so there is NO
// "force match/approve" action.
import { MpesaSmsSubmission, SUBMISSION_STATE } from '../../models/MpesaSmsSubmission.js';
import { estateFilterClause } from '../../utils/estateFilter.js';
import { audit, auditRequired } from '../audit.service.js';
import { openEnvelope } from '../../utils/g5Envelope.js';
import { matchSubmission } from './mpesaSubmission.service.js';
import { Errors } from '../../utils/errors.js';

export const REASON_CODES = Object.freeze(['DUPLICATE', 'WRONG_TENANT', 'NOT_A_RENT_PAYMENT', 'UNREADABLE', 'OTHER_DOCUMENTED']);
const REVIEWABLE = [SUBMISSION_STATE.UNSUPPORTED, SUBMISSION_STATE.UNMATCHED, SUBMISSION_STATE.CONFLICTING, SUBMISSION_STATE.MANUAL_REVIEW];

export const mpesaSubmissionReviewService = {
  list: async ({ clientId, estateFilter, state, limit = 50 }) => MpesaSmsSubmission.find({
    clientId, ...estateFilterClause(estateFilter), ...(state ? { state } : { state: { $in: REVIEWABLE } }),
  }).sort({ createdAt: -1 }).limit(Math.min(Number(limit) || 50, 200))
    .select('tenantId estateId state stateReason amountCents receiptNumber createdAt mpesaTransactionId'),

  async evidence({ clientId, estateFilter, id, actor }) {
    const scope = { _id: id, clientId, ...estateFilterClause(estateFilter) };
    const row = await MpesaSmsSubmission.findOne(scope)
      .select('_id clientId estateId state stateReason parserVersion template parseErrors createdAt retentionState +evidenceEnvelope')
      .lean();
    if (!row) throw Errors.NotFound('Submission not found');

    let message = null;
    if (typeof row.evidenceEnvelope === 'string' && row.evidenceEnvelope.length > 0) {
      try {
        message = openEnvelope(
          row.evidenceEnvelope,
          `g5sub:${row._id}:${row.clientId}`
        );
      } catch {
        // Never expose envelope/key details or fall back to a digest.
        throw Errors.ServiceUnavailable('Original submitted SMS is temporarily unavailable');
      }
    }

    const available = message !== null;
    const unavailableReason = available
      ? null
      : row.retentionState === 'NOT_RETAINED_POLICY_PENDING'
        ? 'NOT_RETAINED'
        : 'UNAVAILABLE';

    // Required audit: do not return plaintext if the evidence-view event cannot be recorded.
    // Raw message, digest, and encrypted envelope are deliberately excluded.
    await auditRequired({
      clientId: row.clientId,
      estateId: row.estateId,
      userId: actor?.userId,
      action: 'G5_SUBMISSION_EVIDENCE_VIEWED',
      resource: 'MpesaSmsSubmission',
      resourceId: String(row._id),
      metadata: {
        available,
        unavailableReason,
        state: row.state,
        parserVersion: row.parserVersion || null,
        retentionState: row.retentionState || null,
      },
      ipAddress: actor?.ip,
      userAgent: actor?.userAgent,
    });

    return {
      id: String(row._id),
      available,
      unavailableReason,
      message,
      state: row.state,
      stateReason: row.stateReason || null,
      parserVersion: row.parserVersion || null,
      template: row.template || null,
      parseErrors: Array.isArray(row.parseErrors) ? row.parseErrors : [],
      createdAt: row.createdAt,
    };
  },

  async resolve({ clientId, estateFilter, id, action, reasonCode, actor }) {
    if (!REASON_CODES.includes(reasonCode)) throw Errors.InvalidRequest('Invalid reason code');
    const scope = { _id: id, clientId, ...estateFilterClause(estateFilter) };
    const sub = await MpesaSmsSubmission.findOne(scope);
    if (!sub) throw Errors.NotFound('Submission not found');
    if (sub.state === SUBMISSION_STATE.POSTED) throw Errors.Conflict('Already posted; no second Payment can be created');
    const before = { state: sub.state, reason: sub.stateReason };
    let next;
    if (action === 'REJECT') next = SUBMISSION_STATE.REJECTED;
    else if (action === 'RETRY_MATCH') next = SUBMISSION_STATE.PARSED;
    else throw Errors.InvalidRequest('Unsupported action');
    if (action === 'RETRY_MATCH' && !sub.receiptNumber) throw Errors.Conflict('Unparsed submission cannot be re-matched');
    const r = await MpesaSmsSubmission.updateOne(
      { ...scope, state: sub.state },
      { $set: { state: next, stateReason: action === 'REJECT' ? reasonCode : null, reviewedByUserId: actor?.userId || null, reviewReasonCode: reasonCode } }
    );
    if (r.matchedCount !== 1) throw Errors.Conflict('Submission changed concurrently');
    await audit({ clientId, estateId: sub.estateId, userId: actor?.userId, action: 'G5_SUBMISSION_REVIEWED',
      resource: 'MpesaSmsSubmission', resourceId: sub._id, metadata: { action, reasonCode, before, after: { state: next } },
      ipAddress: actor?.ip, userAgent: actor?.userAgent });
    if (action === 'RETRY_MATCH') await matchSubmission(sub._id).catch(() => {});
    return { id: sub._id, state: (await MpesaSmsSubmission.findById(sub._id).select('state')).state };
  },
};
