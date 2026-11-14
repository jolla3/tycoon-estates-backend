// src/services/mpesa/mpesaIngestion.service.js
// G5.3 — Durable inbox persist + leased processing + canonical reconciliation.
// Stage 1 persist is outside the processing transaction (ack-after-persist).
// Stage 2 processClaimedEvent commits canonical + event outcome together.

import crypto from 'crypto';
import mongoose from 'mongoose';
import { MpesaIngestionEvent } from '../../models/MpesaIngestionEvent.js';
import { MpesaTransaction } from '../../models/MpesaTransaction.js';
import { MpesaMerchantProfile } from '../../models/MpesaMerchantProfile.js';
import {
  INGESTION_STATE,
  TXN_VERIFICATION_STATE,
  DARAJA_PROVIDER,
} from './daraja.constants.js';
import { logger } from '../../config/logger.js';
import {
  isInboxIdempotencyReady,
  isCanonicalReceiptIdentityReady,
} from '../../utils/mpesaIndexReadiness.js';

const LEASE_TTL_MS = 120_000;

function redactNormalized(n) {
  return {
    receiptNumber: n.receiptNumber,
    businessShortCode: n.businessShortCode,
    amountCents: n.amountCents,
    transactionAt: n.transactionAt,
    transactionType: n.transactionType,
    billRefNumber: n.billRefNumber,
    validationErrors: n.validationErrors,
  };
}

export function leaseLostError() {
  const error = new Error('lease_lost_before_complete');
  error.code = 'lease_lost_before_complete';
  return error;
}

export function newProcessingLeaseToken() {
  return crypto.randomBytes(16).toString('hex');
}

export async function resolveMerchantProfilesByShortCode(businessShortCode, { session } = {}) {
  if (!businessShortCode) return { status: 'none', profiles: [] };
  const profiles = await MpesaMerchantProfile.find({
    provider: DARAJA_PROVIDER,
    businessShortCode: String(businessShortCode),
  }).session(session || null);
  if (!profiles.length) return { status: 'none', profiles: [] };
  const eligible = profiles.filter((p) =>
    ['ACTIVE', 'DRAFT', 'NOT_READY'].includes(p.operationalState)
  );
  if (eligible.length === 0) return { status: 'suspended', profiles };
  if (eligible.length > 1) return { status: 'ambiguous', profiles: eligible };
  return { status: 'exact', profiles: eligible, profile: eligible[0] };
}

export async function resolveMerchantProfileByShortCode(businessShortCode, opts) {
  const r = await resolveMerchantProfilesByShortCode(businessShortCode, opts);
  return r.profile || null;
}

export const PERSIST_OUTCOME = Object.freeze({
  CREATED: 'created',
  DUPLICATE: 'duplicate',
  CONFLICT: 'conflict',
});

const MAX_CONFLICT_DIGESTS = 5;

function canonicalJson(value) {
  return JSON.stringify(value);
}

/**
 * Source-observation idempotency key (architecture 31.3). Includes the source channel, so a C2B
 * delivery and a Pull row for one receipt are two observations. It is not canonical receipt
 * identity and never feeds MpesaTransaction. payloadDigest is excluded: a changed payload for the
 * same observation is a conflict, not a new event.
 */
export function buildInboxIdempotencyKey(normalized) {
  const sha = (arr) => crypto.createHash('sha256').update(canonicalJson(arr)).digest('hex');
  const { sourceChannel, businessShortCode, receiptNumber, payloadDigest } = normalized;
  if (sourceChannel && businessShortCode && receiptNumber) {
    return `obs1:${sha(['obs1', DARAJA_PROVIDER, sourceChannel, String(businessShortCode), String(receiptNumber)])}`;
  }
  return `mal1:${sha(['mal1', DARAJA_PROVIDER, String(sourceChannel || ''), payloadDigest])}`;
}

function isDuplicateKeyError(err) {
  return err && (err.code === 11000 || err.code === 11001);
}

async function recordDuplicate(key, digest, { session }) {
  const existing = await MpesaIngestionEvent.findOne({ idempotencyKey: key }).session(session || null);
  if (!existing) {
    const err = new Error('inbox_duplicate_lookup_failed');
    err.code = 'inbox_duplicate_lookup_failed';
    throw err;
  }
  const now = new Date();
  if (existing.payloadDigest === digest) {
    await MpesaIngestionEvent.updateOne(
      { _id: existing._id },
      { $inc: { replayCount: 1 }, $set: { lastReplayAt: now } },
      { session: session || null }
    );
    return { event: existing, outcome: PERSIST_OUTCOME.DUPLICATE };
  }
  // Conflicting replay: quarantine, fence any active lease, never touch original data.
  const conflicted = await MpesaIngestionEvent.findOneAndUpdate(
    { _id: existing._id },
    [
      {
        $set: {
          state: INGESTION_STATE.QUARANTINED,
          quarantineCategory: 'replay_conflict',
          reasonCode: 'conflicting_payload_for_same_observation',
          processingLeaseToken: null,
          processingLeaseExpiresAt: null,
          conflictCount: { $add: [{ $ifNull: ['$conflictCount', 0] }, 1] },
          firstConflictAt: { $ifNull: ['$firstConflictAt', now] },
          lastConflictAt: now,
          conflictDigests: {
            $slice: [
              {
                $cond: [
                  { $in: [digest, { $ifNull: ['$conflictDigests', []] }] },
                  { $ifNull: ['$conflictDigests', []] },
                  { $concatArrays: [{ $ifNull: ['$conflictDigests', []] }, [digest]] },
                ],
              },
              MAX_CONFLICT_DIGESTS,
            ],
          },
        },
      },
    ],
    { new: true, session: session || null }
  );
  return { event: conflicted || existing, outcome: PERSIST_OUTCOME.CONFLICT };
}

/**
 * Stage 1 persist with durable idempotency. Throws (caller must NOT acknowledge) when the
 * idempotency index is not verified, on lookup failure after an insert race, or on any other error.
 */
export async function persistIngestionObservation(
  normalized,
  { session, readyCheck = isInboxIdempotencyReady } = {}
) {
  if (!normalized || typeof normalized !== 'object') throw new Error('normalized observation required');
  if (!normalized.payloadDigest) throw new Error('payloadDigest required');
  if (!(await readyCheck())) {
    const err = new Error('inbox_idempotency_not_ready');
    err.code = 'inbox_idempotency_not_ready';
    throw err;
  }
  const key = buildInboxIdempotencyKey(normalized);
  try {
    const [event] = await MpesaIngestionEvent.create(
      [{
        provider: DARAJA_PROVIDER,
        sourceChannel: normalized.sourceChannel,
        businessShortCode: normalized.businessShortCode || null,
        receiptNumber: normalized.receiptNumber || null,
        payloadDigest: normalized.payloadDigest,
        idempotencyKey: key,
        payloadRedacted: redactNormalized(normalized),
        state: normalized.ok ? INGESTION_STATE.RECEIVED : INGESTION_STATE.QUARANTINED,
        quarantineCategory: normalized.ok ? null : 'validation_failed',
        reasonCode: normalized.ok ? null : (normalized.validationErrors || []).join(','),
      }],
      { session }
    );
    return { event, outcome: PERSIST_OUTCOME.CREATED };
  } catch (err) {
    if (!isDuplicateKeyError(err)) throw err;
    // Inside a Mongo transaction a duplicate-key error aborts it; the caller's transaction must
    // retry. Outside one (the normal Stage 1 path) re-read and classify.
    if (session?.inTransaction?.()) throw err;
    return recordDuplicate(key, normalized.payloadDigest, { session });
  }
}

/** Back-compat wrapper: returns only the event. New callers use persistIngestionObservation. */
export async function persistIngestionEvent(normalized, opts) {
  return (await persistIngestionObservation(normalized, opts)).event;
}

export async function claimIngestionEvent(eventId, { ttlMs = LEASE_TTL_MS, session } = {}) {
  const token = newProcessingLeaseToken();
  const now = new Date();
  const expires = new Date(now.getTime() + ttlMs);
  const updated = await MpesaIngestionEvent.findOneAndUpdate(
    {
      _id: eventId,
      $or: [
        { state: INGESTION_STATE.RECEIVED },
        { state: INGESTION_STATE.FAILED_RETRYABLE },
        { state: INGESTION_STATE.PROCESSING, processingLeaseExpiresAt: { $lte: now } },
      ],
    },
    {
      $set: {
        state: INGESTION_STATE.PROCESSING,
        processingLeaseToken: token,
        processingLeaseExpiresAt: expires,
        processingStartedAt: now,
      },
      $inc: { attempts: 1 },
    },
    { new: true, session: session || null }
  );
  if (!updated) return null;
  return { event: updated, leaseToken: token };
}

export async function completeIngestionEvent(
  eventId,
  leaseToken,
  { state, quarantineCategory = null, reasonCode = null, normalizedTransactionId = null, session = null }
) {
  return MpesaIngestionEvent.findOneAndUpdate(
    { _id: eventId, processingLeaseToken: leaseToken, state: INGESTION_STATE.PROCESSING },
    {
      $set: {
        state,
        quarantineCategory,
        reasonCode,
        normalizedTransactionId,
        processingLeaseToken: null,
        processingLeaseExpiresAt: null,
      },
    },
    { new: true, session }
  );
}

/**
 * Stage 2 — process claimed event. Without a session, wraps work in a MongoDB
 * transaction so canonical mutation and event completion commit together.
 */
export async function processClaimedEvent(event, leaseToken, normalized, { session } = {}) {
  if (!session) {
    const ownSession = await mongoose.startSession();
    try {
      let outcome;
      await ownSession.withTransaction(async () => {
        outcome = await processClaimedEvent(event, leaseToken, normalized, {
          session: ownSession,
        });
      });
      return outcome;
    } catch (err) {
      logger.error(
        { err: err.message, eventId: String(event._id) },
        'processClaimedEvent transaction failed'
      );
      try {
        await completeIngestionEvent(event._id, leaseToken, {
          state: INGESTION_STATE.FAILED_RETRYABLE,
          reasonCode: 'processing_transaction_failed',
        });
      } catch {
        // Lease may already be lost; reclaim path will retry.
      }
      throw err;
    } finally {
      await ownSession.endSession();
    }
  }

  const resolution = await resolveMerchantProfilesByShortCode(normalized.businessShortCode, { session });
  if (resolution.status === 'none') {
    await completeIngestionEvent(event._id, leaseToken, {
      state: INGESTION_STATE.QUARANTINED,
      quarantineCategory: 'unknown_shortcode',
      reasonCode: 'no_merchant_profile',
      session,
    });
    return { quarantined: true, reason: 'unknown_shortcode', transaction: null };
  }
  if (resolution.status === 'ambiguous') {
    await completeIngestionEvent(event._id, leaseToken, {
      state: INGESTION_STATE.QUARANTINED,
      quarantineCategory: 'ambiguous_merchant',
      reasonCode: 'multiple_profiles_for_shortcode',
      session,
    });
    return { quarantined: true, reason: 'ambiguous_merchant', transaction: null };
  }
  if (resolution.status === 'suspended') {
    await completeIngestionEvent(event._id, leaseToken, {
      state: INGESTION_STATE.QUARANTINED,
      quarantineCategory: 'suspended_merchant',
      reasonCode: 'no_eligible_operational_state',
      session,
    });
    return { quarantined: true, reason: 'suspended_merchant', transaction: null };
  }
  if (!normalized.ok) {
    await completeIngestionEvent(event._id, leaseToken, {
      state: INGESTION_STATE.QUARANTINED,
      quarantineCategory: 'validation_failed',
      reasonCode: (normalized.validationErrors || []).join(','),
      session,
    });
    return { quarantined: true, reason: 'validation_failed', transaction: null };
  }

  const profile = resolution.profile;
  await MpesaIngestionEvent.updateOne(
    { _id: event._id, processingLeaseToken: leaseToken },
    { $set: { merchantProfileId: profile._id, clientId: profile.clientId } },
    { session }
  );

  // Fail closed: no MpesaTransaction write while canonical receipt identity is unverified.
  if (!canonicalIdentityReady()) {
    await completeIngestionEvent(event._id, leaseToken, {
      state: INGESTION_STATE.QUARANTINED,
      quarantineCategory: 'canonical_identity_unverified',
      reasonCode: 'canonical_receipt_identity_not_verified',
      session,
    });
    return { quarantined: true, reason: 'canonical_identity_unverified', transaction: null };
  }

  try {
    const upsert = await upsertCanonicalTransaction(normalized, profile, { session });
    const completed = await completeIngestionEvent(event._id, leaseToken, {
      state: upsert.conflict ? INGESTION_STATE.QUARANTINED : INGESTION_STATE.PROCESSED,
      quarantineCategory: upsert.conflict ? 'conflict' : null,
      reasonCode: upsert.conflictReason || null,
      normalizedTransactionId: upsert.transaction?._id || null,
      session,
    });
    if (!completed) throw leaseLostError();
    return {
      quarantined: Boolean(upsert.conflict),
      conflict: Boolean(upsert.conflict),
      transaction: upsert.transaction,
      created: upsert.created,
    };
  } catch (err) {
    logger.error({ err: err.message, eventId: String(event._id) }, 'Canonical upsert failed');
    // Do not mark PROCESSED here; leave PROCESSING for reclaim or outer FAILED_RETRYABLE.
    throw err;
  }
}

export async function ingestNormalizedObservation(normalized, { session } = {}) {
  const persisted = await persistIngestionObservation(normalized, { session });
  const event = persisted.event;
  if (persisted.outcome !== PERSIST_OUTCOME.CREATED) {
    return {
      persisted: true,
      event,
      duplicateEvent: persisted.outcome === PERSIST_OUTCOME.DUPLICATE,
      replayConflict: persisted.outcome === PERSIST_OUTCOME.CONFLICT,
      transaction: null,
    };
  }
  const claim = await claimIngestionEvent(event._id, { session });
  if (!claim) return { persisted: true, event, duplicateEvent: false, deferred: true };
  try {
    const result = await processClaimedEvent(claim.event, claim.leaseToken, normalized, { session });
    return { persisted: true, event: claim.event, duplicateEvent: false, ...result };
  } catch (err) {
    return {
      persisted: true,
      event: claim.event,
      processingError: err.message,
      quarantined: false,
      transaction: null,
    };
  }
}

function canonicalIdentityReady() {
  return isCanonicalReceiptIdentityReady();
}

async function upsertCanonicalTransaction(normalized, profile, { session } = {}) {
  if (!canonicalIdentityReady()) {
    const err = new Error('canonical_identity_unverified');
    err.code = 'canonical_identity_unverified';
    throw err;
  }
  const filter = {
    provider: DARAJA_PROVIDER,
    businessShortCode: normalized.businessShortCode,
    receiptNumber: normalized.receiptNumber,
  };
  const existing = await MpesaTransaction.findOne(filter).session(session || null);
  if (!existing) {
    try {
      const [created] = await MpesaTransaction.create(
        [{
          provider: DARAJA_PROVIDER,
          clientId: profile.clientId,
          merchantProfileId: profile._id,
          businessShortCode: normalized.businessShortCode,
          receiptNumber: normalized.receiptNumber,
          amountCents: normalized.amountCents,
          currency: normalized.currency || 'KES',
          transactionAt: normalized.transactionAt,
          billRefNumber: normalized.billRefNumber,
          transactionType: normalized.transactionType,
          sourceChannels: [normalized.sourceChannel],
          verificationState: TXN_VERIFICATION_STATE.UNVERIFIED,
          acceptedAmountCents: normalized.amountCents,
          acceptedTransactionAt: normalized.transactionAt,
        }],
        { session }
      );
      return { transaction: created, created: true, conflict: false };
    } catch (err) {
      if (err?.code === 11000) {
        const raced = await MpesaTransaction.findOne(filter).session(session || null);
        return mergeObservation(raced, normalized, { session });
      }
      throw err;
    }
  }
  return mergeObservation(existing, normalized, { session });
}

async function mergeObservation(existing, normalized, { session } = {}) {
  if (!existing) {
    return { transaction: null, created: false, conflict: true, conflictReason: 'missing_after_race' };
  }
  const amountMismatch = existing.acceptedAmountCents !== normalized.amountCents;
  const timeMismatch =
    existing.acceptedTransactionAt.getTime() !== new Date(normalized.transactionAt).getTime();
  if (amountMismatch || timeMismatch) {
    const conflictReason = [
      amountMismatch ? 'amount_mismatch' : null,
      timeMismatch ? 'time_mismatch' : null,
    ].filter(Boolean).join(',');
    await MpesaTransaction.updateOne(
      { _id: existing._id },
      {
        $set: { verificationState: TXN_VERIFICATION_STATE.CONFLICT, conflictReason },
        $addToSet: { sourceChannels: normalized.sourceChannel },
      },
      { session: session || null }
    );
    const refreshed = await MpesaTransaction.findById(existing._id).session(session || null);
    return { transaction: refreshed, created: false, conflict: true, conflictReason };
  }
  await MpesaTransaction.updateOne(
    { _id: existing._id },
    { $addToSet: { sourceChannels: normalized.sourceChannel } },
    { session: session || null }
  );
  const refreshed = await MpesaTransaction.findById(existing._id).session(session || null);
  return { transaction: refreshed, created: false, conflict: false };
}

const RECEIVED_MIN_AGE_MS = 30_000; // let the synchronous request-path claim fresh RECEIVED rows first
const RETRY_BACKOFF_BASE_MS = 30_000;
const RETRY_BACKOFF_MAX_MS = 30 * 60 * 1000;
const MAX_RECOVERY_ATTEMPTS = 8;

/** Exponential backoff so a repeatedly-failing event is retried less often over time, never in a tight loop. */
export function nextRetryBackoffMs(attempts) {
  const capped = Math.min(Math.max(attempts, 1), 10);
  return Math.min(RETRY_BACKOFF_BASE_MS * 2 ** (capped - 1), RETRY_BACKOFF_MAX_MS);
}

/**
 * Rebuilds a normalized observation from an event's own persisted, redacted fields — never from
 * an unavailable raw callback body. Only the fields `persistIngestionObservation` already stored
 * are used; nothing is guessed. Returns null when there isn't enough safe data to reconstruct.
 */
export function reconstructNormalizedObservation(event) {
  if (!event?.sourceChannel || !event?.payloadDigest) return null;
  const redacted = event.payloadRedacted || {};
  return {
    sourceChannel: event.sourceChannel,
    businessShortCode: event.businessShortCode ?? null,
    receiptNumber: event.receiptNumber ?? redacted.receiptNumber ?? null,
    payloadDigest: event.payloadDigest,
    ok: true, // only RECEIVED/FAILED_RETRYABLE/expired-PROCESSING events reach recovery; all were ok:true at persist
    amountCents: redacted.amountCents,
    transactionAt: redacted.transactionAt,
    transactionType: redacted.transactionType,
    billRefNumber: redacted.billRefNumber,
  };
}

/**
 * Recovers orphaned RECEIVED events (claimed but never processed before a crash), FAILED_RETRYABLE
 * events whose backoff has elapsed, and PROCESSING events whose lease expired — then actually runs
 * them through the same claim + processClaimedEvent lifecycle the live request path uses. Never
 * bypasses inbox readiness, the canonical fail-closed gate, or financial posting: it reuses those
 * same functions unmodified. Safe under multiple concurrent workers because claimIngestionEvent's
 * conditional findOneAndUpdate is the only thing that lets a worker proceed with a given event.
 */
export async function reclaimExpiredProcessingEvents({ limit = 50 } = {}) {
  const now = new Date();
  const receivedCutoff = new Date(now.getTime() - RECEIVED_MIN_AGE_MS);
  const candidates = await MpesaIngestionEvent.find({
    $or: [
      { state: INGESTION_STATE.RECEIVED, createdAt: { $lte: receivedCutoff } },
      {
        state: INGESTION_STATE.FAILED_RETRYABLE,
        $or: [{ nextAttemptAt: null }, { nextAttemptAt: { $lte: now } }],
      },
      { state: INGESTION_STATE.PROCESSING, processingLeaseExpiresAt: { $lte: now } },
    ],
  }).sort({ receivedAt: 1 }).limit(limit);

  const results = [];
  for (const ev of candidates) {
    if (ev.attempts >= MAX_RECOVERY_ATTEMPTS) {
      await MpesaIngestionEvent.updateOne(
        { _id: ev._id, state: ev.state },
        { $set: { state: INGESTION_STATE.FAILED_TERMINAL, reasonCode: 'max_recovery_attempts_exceeded' } }
      );
      results.push({ eventId: String(ev._id), outcome: 'terminal_max_attempts' });
      continue;
    }

    const claim = await claimIngestionEvent(ev._id);
    if (!claim) {
      // Another worker (or the live request path) already claimed it, or it changed state
      // (e.g. was conflicted) between the find and now. Lease fencing made this safe to skip.
      results.push({ eventId: String(ev._id), outcome: 'not_claimed' });
      continue;
    }

    const normalized = reconstructNormalizedObservation(claim.event);
    if (!normalized) {
      await completeIngestionEvent(claim.event._id, claim.leaseToken, {
        state: INGESTION_STATE.QUARANTINED,
        quarantineCategory: 'recovery_insufficient_data',
        reasonCode: 'cannot_reconstruct_normalized_observation',
      });
      results.push({ eventId: String(ev._id), outcome: 'quarantined_insufficient_data' });
      continue;
    }

    try {
      const outcome = await processClaimedEvent(claim.event, claim.leaseToken, normalized);
      results.push({ eventId: String(ev._id), outcome: 'processed', quarantined: Boolean(outcome.quarantined) });
    } catch (err) {
      const attempts = (claim.event.attempts || 0);
      await MpesaIngestionEvent.updateOne(
        { _id: claim.event._id, processingLeaseToken: claim.leaseToken, state: INGESTION_STATE.PROCESSING },
        {
          $set: {
            state: INGESTION_STATE.FAILED_RETRYABLE,
            reasonCode: 'recovery_processing_failed',
            nextAttemptAt: new Date(Date.now() + nextRetryBackoffMs(attempts)),
            processingLeaseToken: null,
            processingLeaseExpiresAt: null,
          },
        }
      );
      logger.error({ err: err.message, eventId: String(ev._id) }, 'Recovery processing failed; rescheduled with backoff');
      results.push({ eventId: String(ev._id), outcome: 'rescheduled', error: err.message });
    }
  }
  return results;
}
