// src/services/g5ProtectedSms.service.js
//
// G5 protected SMS outbox. Reuses SmsMessage + the Celcom provider factory.
//  - recipient phone and body are stored ONLY inside an AEAD envelope
//  - AAD binds immutable notification identity (not just message/client id)
//  - dispatch uses a fenced lease; sendStartedAt is durable BEFORE the provider call
//  - callers may insert inside their own Mongo session (no provider calls in-tx)
//  - no plaintext fallback if the envelope cannot be sealed/opened

import crypto from 'crypto';
import mongoose from 'mongoose';
import { SmsMessage } from '../models/SmsMessage.js';
import { MpesaSubmissionLink } from '../models/MpesaSubmissionLink.js';
import { sealEnvelope, openEnvelope, envelopeKeyId } from '../utils/g5Envelope.js';
import { getSmsProvider } from './sms/sms.factory.js';
import { env } from '../config/environment.js';
import { logger } from '../config/logger.js';

export const PROTECTED_LEASE_MS = 90_000;
export const G5_ONBOARDING_TYPE = 'g5_onboarding_link';
export const G5_ONBOARDING_VERSION = 'g5_onboarding_link:v1';
export const G5_PAYMENT_CONFIRM_TYPE = 'payment_confirmation';
const PLACEHOLDER = '[protected]';

/** Canonical AAD for AEAD. Must match exactly on seal and open. */
export function buildProtectedSmsAad({
  messageId, clientId, estateId = null, tenantId = null, linkId = null,
  linkVersion = null, type = null, notificationVersion = null, idempotencyKey = null,
}) {
  const parts = [
    'g5sms',
    String(messageId),
    String(clientId),
    estateId != null ? String(estateId) : '-',
    tenantId != null ? String(tenantId) : '-',
    linkId != null ? String(linkId) : '-',
    linkVersion != null ? String(linkVersion) : '-',
    type != null ? String(type) : '-',
    notificationVersion != null ? String(notificationVersion) : '-',
    idempotencyKey != null ? String(idempotencyKey) : '-',
  ];
  return parts.join(':');
}

/**
 * Insert a protected outbox row. Accepts an optional caller-owned session.
 * Generates a fresh AEAD nonce on every call (including transaction retries).
 */
export async function queueProtectedSms({
  clientId, estateId, tenantId = null, houseId = null, phone, body,
  type = G5_PAYMENT_CONFIRM_TYPE,
  notificationVersion = null,
  idempotencyKey, linkId = null, linkVersion = null, dispatchMode = 'ENABLED',
  session = null,
}) {
  if (!idempotencyKey || !phone || !body) {
    throw new Error('queueProtectedSms: idempotencyKey, phone and body are required');
  }
  const fullKey = `g5:${idempotencyKey}`;
  // Stable row id for this logical notification so AAD stays consistent on retry
  // when the caller reuses the same idempotency key after a transient failure.
  const existing = await SmsMessage.findOne({ clientId, idempotencyKey: fullKey })
    .session(session || null).select('_id');
  if (existing) return { id: existing._id, created: false };

  const _id = new mongoose.Types.ObjectId();
  const aad = buildProtectedSmsAad({
    messageId: _id, clientId, estateId, tenantId, linkId, linkVersion,
    type, notificationVersion, idempotencyKey: fullKey,
  });
  // Fresh envelope every attempt — never reuse nonce across retries.
  const envelope = sealEnvelope(JSON.stringify({ phone, body }), aad);
  try {
    const docs = await SmsMessage.create([{
      _id, clientId, estateId, tenantId, houseId, type,
      phoneNumber: PLACEHOLDER, message: PLACEHOLDER,
      deliveryMode: 'G5_PROTECTED',
      payloadEnvelope: envelope,
      payloadKeyId: envelopeKeyId(envelope),
      dispatchMode,
      idempotencyKey: fullKey,
      g5LinkId: linkId,
      g5LinkVersion: linkVersion,
      notificationVersion: notificationVersion || null,
    }], { session: session || undefined });
    return { id: docs[0]._id, created: true };
  } catch (err) {
    if (err?.code === 11000) return { id: null, created: false };
    throw err;
  }
}

/** Cancel still-queued protected messages bound to a link (rotation/revocation). */
export async function cancelQueuedForLink(linkId, { clientId, session = null } = {}) {
  const r = await SmsMessage.updateMany(
    { clientId, g5LinkId: linkId, deliveryMode: 'G5_PROTECTED', status: 'queued' },
    { $set: { status: 'cancelled', failureReason: 'link_rotated_or_revoked' } },
    { session: session || undefined }
  );
  return r.modifiedCount;
}

async function recoverStale(now) {
  await SmsMessage.updateMany(
    {
      deliveryMode: 'G5_PROTECTED', status: 'processing',
      dispatchLeaseExpiresAt: { $lte: now }, sendStartedAt: null,
    },
    { $set: { status: 'queued', dispatchLeaseToken: null, dispatchLeaseExpiresAt: null } }
  );
  await SmsMessage.updateMany(
    {
      deliveryMode: 'G5_PROTECTED', status: 'processing',
      dispatchLeaseExpiresAt: { $lte: now }, sendStartedAt: { $ne: null },
    },
    {
      $set: {
        status: 'unknown', failureReason: 'lease_lost_after_send_started',
        dispatchLeaseToken: null, dispatchLeaseExpiresAt: null,
      },
    }
  );
}

/**
 * Protected dispatcher. Default-off via G5_PROTECTED_SMS_ENABLED.
 */
export async function dispatchProtectedBatch(limit = 20) {
  if (env.G5_PROTECTED_SMS_ENABLED !== '1') {
    logger.debug('Protected SMS dispatch skipped — G5_PROTECTED_SMS_ENABLED is not 1');
    return 0;
  }
  const provider = getSmsProvider('celcom');
  const now = new Date();
  await recoverStale(now);
  let processed = 0;
  for (let i = 0; i < limit; i += 1) {
    const token = crypto.randomBytes(16).toString('hex');
    const row = await SmsMessage.findOneAndUpdate(
      {
        deliveryMode: 'G5_PROTECTED',
        dispatchMode: 'ENABLED',
        status: 'queued',
        sendStartedAt: null,
        $or: [{ nextRetryAt: null }, { nextRetryAt: { $lte: new Date() } }],
      },
      {
        $set: {
          status: 'processing',
          dispatchLeaseToken: token,
          dispatchLeaseExpiresAt: new Date(Date.now() + PROTECTED_LEASE_MS),
        },
      },
      { sort: { priority: -1, createdAt: 1 }, new: true }
    ).select('+payloadEnvelope');
    if (!row) break;
    processed += 1;

    const complete = (set) => SmsMessage.updateOne(
      { _id: row._id, dispatchLeaseToken: token, status: 'processing' },
      { $set: { ...set, dispatchLeaseToken: null, dispatchLeaseExpiresAt: null } }
    );

    // Link eligibility: if bound to a link version, that version must still be ACTIVE.
    if (row.g5LinkId != null && row.g5LinkVersion != null) {
      const linkOk = await MpesaSubmissionLink.findOne({
        _id: row.g5LinkId,
        clientId: row.clientId,
        status: 'ACTIVE',
        linkVersion: row.g5LinkVersion,
      }).select('_id');
      if (!linkOk) {
        await complete({ status: 'cancelled', failureReason: 'link_no_longer_eligible' });
        continue;
      }
    }

    const aad = buildProtectedSmsAad({
      messageId: row._id,
      clientId: row.clientId,
      estateId: row.estateId,
      tenantId: row.tenantId,
      linkId: row.g5LinkId,
      linkVersion: row.g5LinkVersion,
      type: row.type,
      notificationVersion: row.notificationVersion,
      idempotencyKey: row.idempotencyKey,
    });

    let payload;
    try {
      payload = JSON.parse(openEnvelope(row.payloadEnvelope, aad));
    } catch (err) {
      await complete({
        status: 'failed', failedAt: new Date(),
        failureReason: `envelope_${err.code || 'error'}`,
      });
      continue;
    }

    const started = await SmsMessage.updateOne(
      {
        _id: row._id, dispatchLeaseToken: token,
        status: 'processing', sendStartedAt: null,
      },
      { $set: { sendStartedAt: new Date() } }
    );
    if (started.matchedCount !== 1) continue;

    let result;
    try {
      result = await provider.send(payload.phone, payload.body, row.idempotencyKey);
    } catch (err) {
      result = { success: false, status: 'unknown', errorMessage: 'provider_exception' };
    }
    if (result.success) {
      await complete({ status: 'sent', sentAt: new Date(), providerMessageId: result.providerMessageId });
    } else if (result.status === 'unknown') {
      await complete({
        status: 'unknown',
        failureReason: String(result.errorMessage || 'unknown').slice(0, 200),
      });
    } else if (result.retryable && row.retryCount + 1 < row.maxRetries) {
      await SmsMessage.updateOne(
        { _id: row._id, dispatchLeaseToken: token, status: 'processing' },
        {
          $set: {
            status: 'queued', sendStartedAt: null,
            nextRetryAt: new Date(Date.now() + 60_000),
            failureReason: String(result.errorMessage || '').slice(0, 200),
            dispatchLeaseToken: null, dispatchLeaseExpiresAt: null,
          },
          $inc: { retryCount: 1 },
        }
      );
    } else {
      await complete({
        status: 'failed', failedAt: new Date(),
        failureReason: String(result.errorMessage || '').slice(0, 200),
      });
    }
    logger.info({ smsId: String(row._id) }, 'Protected SMS processed');
  }
  return processed;
}
