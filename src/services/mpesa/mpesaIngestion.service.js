// src/services/mpesa/mpesaIngestion.service.js
// G5.3 — Durable inbox persist + leased processing + canonical reconciliation.
// Never creates G3 Payment / allocation / Ledger rows.

import crypto from 'crypto';
import { MpesaIngestionEvent } from '../../models/MpesaIngestionEvent.js';
import { MpesaTransaction } from '../../models/MpesaTransaction.js';
import { MpesaMerchantProfile } from '../../models/MpesaMerchantProfile.js';
import {
  INGESTION_STATE,
  TXN_VERIFICATION_STATE,
  DARAJA_PROVIDER,
} from './daraja.constants.js';
import { logger } from '../../config/logger.js';

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

export async function persistIngestionEvent(normalized, { session } = {}) {
  if (!normalized || typeof normalized !== 'object') throw new Error('normalized observation required');
  if (!normalized.payloadDigest) throw new Error('payloadDigest required');
  const [event] = await MpesaIngestionEvent.create(
    [{
      provider: DARAJA_PROVIDER,
      sourceChannel: normalized.sourceChannel,
      businessShortCode: normalized.businessShortCode || null,
      receiptNumber: normalized.receiptNumber || null,
      payloadDigest: normalized.payloadDigest,
      payloadRedacted: redactNormalized(normalized),
      state: normalized.ok ? INGESTION_STATE.RECEIVED : INGESTION_STATE.QUARANTINED,
      quarantineCategory: normalized.ok ? null : 'validation_failed',
      reasonCode: normalized.ok ? null : (normalized.validationErrors || []).join(','),
    }],
    { session }
  );
  return event;
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

export async function processClaimedEvent(event, leaseToken, normalized, { session } = {}) {
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
    { session: session || null }
  );
  try {
    const upsert = await upsertCanonicalTransaction(normalized, profile, { session });
    await completeIngestionEvent(event._id, leaseToken, {
      state: upsert.conflict ? INGESTION_STATE.QUARANTINED : INGESTION_STATE.PROCESSED,
      quarantineCategory: upsert.conflict ? 'conflict' : null,
      reasonCode: upsert.conflictReason || null,
      normalizedTransactionId: upsert.transaction?._id || null,
      session,
    });
    return {
      quarantined: Boolean(upsert.conflict),
      conflict: Boolean(upsert.conflict),
      transaction: upsert.transaction,
      created: upsert.created,
    };
  } catch (err) {
    logger.error({ err: err.message, eventId: String(event._id) }, 'Canonical upsert failed');
    await completeIngestionEvent(event._id, leaseToken, {
      state: INGESTION_STATE.FAILED_RETRYABLE,
      reasonCode: 'canonical_upsert_failed',
      session,
    });
    throw err;
  }
}

export async function ingestNormalizedObservation(normalized, { session } = {}) {
  const event = await persistIngestionEvent(normalized, { session });
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

async function upsertCanonicalTransaction(normalized, profile, { session } = {}) {
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

export async function reclaimExpiredProcessingEvents({ limit = 50 } = {}) {
  const now = new Date();
  const stuck = await MpesaIngestionEvent.find({
    state: INGESTION_STATE.PROCESSING,
    processingLeaseExpiresAt: { $lte: now },
  }).sort({ processingLeaseExpiresAt: 1 }).limit(limit);
  const results = [];
  for (const ev of stuck) {
    const claim = await claimIngestionEvent(ev._id);
    results.push({ eventId: String(ev._id), reclaimed: Boolean(claim) });
  }
  return results;
}
