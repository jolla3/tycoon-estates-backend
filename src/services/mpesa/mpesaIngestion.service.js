// src/services/mpesa/mpesaIngestion.service.js
//
// G5.3 — Persist raw ingestion events and upsert canonical MpesaTransaction.
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

function redactNormalized(n) {
  return {
    receiptNumber: n.receiptNumber,
    businessShortCode: n.businessShortCode,
    amountCents: n.amountCents,
    transactionAt: n.transactionAt,
    transactionType: n.transactionType,
    billRefNumber: n.billRefNumber,
    // MSISDN intentionally omitted from redacted default
    validationErrors: n.validationErrors,
  };
}

/**
 * Resolve an ACTIVE/DRAFT profile by shortcode. Unknown shortcodes quarantine.
 */
export async function resolveMerchantProfileByShortCode(businessShortCode, { session } = {}) {
  if (!businessShortCode) return null;
  return MpesaMerchantProfile.findOne({
    provider: DARAJA_PROVIDER,
    businessShortCode: String(businessShortCode),
    operationalState: { $in: ['ACTIVE', 'DRAFT', 'NOT_READY'] },
  }).session(session || null);
}

/**
 * Persist ingestion event then upsert canonical transaction.
 * Idempotent on payloadDigest for the same sourceChannel.
 */
export async function ingestNormalizedObservation(normalized, { session } = {}) {
  if (!normalized || typeof normalized !== 'object') {
    throw new Error('normalized observation required');
  }

  const profile = await resolveMerchantProfileByShortCode(normalized.businessShortCode, {
    session,
  });

  let event;
  try {
    const [created] = await MpesaIngestionEvent.create(
      [
        {
          provider: DARAJA_PROVIDER,
          sourceChannel: normalized.sourceChannel,
          merchantProfileId: profile?._id ?? null,
          clientId: profile?.clientId ?? null,
          businessShortCode: normalized.businessShortCode || null,
          receiptNumber: normalized.receiptNumber || null,
          payloadDigest: normalized.payloadDigest,
          payloadRedacted: redactNormalized(normalized),
          state: normalized.ok ? INGESTION_STATE.RECEIVED : INGESTION_STATE.QUARANTINED,
          quarantineCategory: normalized.ok ? null : 'validation_failed',
          reasonCode: normalized.ok ? null : (normalized.validationErrors || []).join(','),
        },
      ],
      { session }
    );
    event = created;
  } catch (err) {
    if (err?.code === 11000) {
      const existing = await MpesaIngestionEvent.findOne({
        provider: DARAJA_PROVIDER,
        businessShortCode: normalized.businessShortCode || null,
        sourceChannel: normalized.sourceChannel,
        payloadDigest: normalized.payloadDigest,
      }).session(session || null);
      return {
        duplicateEvent: true,
        event: existing,
        transaction: existing?.normalizedTransactionId
          ? await MpesaTransaction.findById(existing.normalizedTransactionId).session(session || null)
          : null,
      };
    }
    throw err;
  }

  if (!normalized.ok) {
    return { duplicateEvent: false, event, transaction: null, quarantined: true };
  }

  if (!profile) {
    event.state = INGESTION_STATE.QUARANTINED;
    event.quarantineCategory = 'unknown_shortcode';
    event.reasonCode = 'no_merchant_profile';
    await event.save({ session });
    return { duplicateEvent: false, event, transaction: null, quarantined: true };
  }

  const upsert = await upsertCanonicalTransaction(normalized, profile, event, { session });
  return { duplicateEvent: false, event, ...upsert };
}

async function upsertCanonicalTransaction(normalized, profile, event, { session } = {}) {
  const filter = {
    provider: DARAJA_PROVIDER,
    businessShortCode: normalized.businessShortCode,
    receiptNumber: normalized.receiptNumber,
  };

  const existing = await MpesaTransaction.findOne(filter).session(session || null);

  if (!existing) {
    try {
      const [created] = await MpesaTransaction.create(
        [
          {
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
          },
        ],
        { session }
      );
      event.normalizedTransactionId = created._id;
      event.state = INGESTION_STATE.PROCESSED;
      await event.save({ session });
      return { transaction: created, created: true, conflict: false };
    } catch (err) {
      if (err?.code === 11000) {
        // Concurrent insert — re-read and merge
        const raced = await MpesaTransaction.findOne(filter).session(session || null);
        return mergeObservation(raced, normalized, event, { session });
      }
      throw err;
    }
  }

  return mergeObservation(existing, normalized, event, { session });
}

async function mergeObservation(existing, normalized, event, { session } = {}) {
  if (!existing) {
    event.state = INGESTION_STATE.FAILED_TERMINAL;
    event.reasonCode = 'missing_canonical_after_race';
    await event.save({ session });
    return { transaction: null, created: false, conflict: true };
  }

  const amountMismatch = existing.acceptedAmountCents !== normalized.amountCents;
  const timeMismatch =
    existing.acceptedTransactionAt.getTime() !== new Date(normalized.transactionAt).getTime();

  if (amountMismatch || timeMismatch) {
    existing.verificationState = TXN_VERIFICATION_STATE.CONFLICT;
    existing.conflictReason = [
      amountMismatch ? 'amount_mismatch' : null,
      timeMismatch ? 'time_mismatch' : null,
    ]
      .filter(Boolean)
      .join(',');
    if (!existing.sourceChannels.includes(normalized.sourceChannel)) {
      existing.sourceChannels.push(normalized.sourceChannel);
    }
    await existing.save({ session });
    event.normalizedTransactionId = existing._id;
    event.state = INGESTION_STATE.QUARANTINED;
    event.quarantineCategory = 'conflict';
    event.reasonCode = existing.conflictReason;
    await event.save({ session });
    logger.warn(
      {
        receiptNumber: existing.receiptNumber,
        shortCode: existing.businessShortCode,
        conflictReason: existing.conflictReason,
      },
      'M-PESA receipt conflict retained'
    );
    return { transaction: existing, created: false, conflict: true };
  }

  if (!existing.sourceChannels.includes(normalized.sourceChannel)) {
    existing.sourceChannels.push(normalized.sourceChannel);
    await existing.save({ session });
  }

  event.normalizedTransactionId = existing._id;
  event.state = INGESTION_STATE.PROCESSED;
  await event.save({ session });
  return { transaction: existing, created: false, conflict: false };
}

export function newProcessingClaimToken() {
  return crypto.randomBytes(16).toString('hex');
}
