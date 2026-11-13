// src/services/g5ProtectedSms.service.js
//
// G5 protected SMS outbox. Reuses SmsMessage + the Celcom provider factory.
//  - recipient phone and body are stored ONLY inside an AEAD envelope (AAD binds row identity)
//  - dispatch uses a fenced lease; completion is a conditional update on the lease token
//  - sendStartedAt is written durably BEFORE the provider call; a row that has started
//    sending and lost its lease is marked `unknown` and NEVER blindly retried
//  - queue only AFTER the Mongo transaction commits; never inside it
//  - no plaintext fallback: if the envelope cannot be sealed/opened the message is not sent

import crypto from 'crypto';
import mongoose from 'mongoose';
import { SmsMessage } from '../models/SmsMessage.js';
import { sealEnvelope, openEnvelope, envelopeKeyId } from '../utils/g5Envelope.js';
import { getSmsProvider } from './sms/sms.factory.js';
import { logger } from '../config/logger.js';

export const PROTECTED_LEASE_MS = 90_000;
const PLACEHOLDER = '[protected]';
const aadFor = (id, clientId) => `g5sms:${String(id)}:${String(clientId)}`;

export async function queueProtectedSms({
  clientId, estateId, tenantId = null, houseId = null, phone, body, type = 'payment_confirmation',
  idempotencyKey, linkId = null, linkVersion = null, dispatchMode = 'ENABLED',
}) {
  if (!idempotencyKey || !phone || !body) throw new Error('queueProtectedSms: idempotencyKey, phone and body are required');
  const _id = new mongoose.Types.ObjectId();
  const envelope = sealEnvelope(JSON.stringify({ phone, body }), aadFor(_id, clientId));
  try {
    const doc = await SmsMessage.create({
      _id, clientId, estateId, tenantId, houseId, type,
      phoneNumber: PLACEHOLDER, message: PLACEHOLDER,
      deliveryMode: 'G5_PROTECTED', payloadEnvelope: envelope, payloadKeyId: envelopeKeyId(envelope),
      dispatchMode, idempotencyKey: `g5:${idempotencyKey}`, g5LinkId: linkId, g5LinkVersion: linkVersion,
    });
    return { id: doc._id, created: true };
  } catch (err) {
    if (err?.code === 11000) return { id: null, created: false };
    throw err;
  }
}

/** Cancel still-queued protected messages bound to an older link version (rotation/revocation). */
export async function cancelQueuedForLink(linkId, { clientId }) {
  const r = await SmsMessage.updateMany(
    { clientId, g5LinkId: linkId, deliveryMode: 'G5_PROTECTED', status: 'queued' },
    { $set: { status: 'cancelled', failureReason: 'link_rotated_or_revoked' } }
  );
  return r.modifiedCount;
}

async function recoverStale(now) {
  // never started sending -> safe to requeue; started -> outcome unknown, never resend
  await SmsMessage.updateMany(
    { deliveryMode: 'G5_PROTECTED', status: 'processing', dispatchLeaseExpiresAt: { $lte: now }, sendStartedAt: null },
    { $set: { status: 'queued', dispatchLeaseToken: null, dispatchLeaseExpiresAt: null } }
  );
  await SmsMessage.updateMany(
    { deliveryMode: 'G5_PROTECTED', status: 'processing', dispatchLeaseExpiresAt: { $lte: now }, sendStartedAt: { $ne: null } },
    { $set: { status: 'unknown', failureReason: 'lease_lost_after_send_started', dispatchLeaseToken: null } }
  );
}

export async function dispatchProtectedBatch(limit = 20) {
  const provider = getSmsProvider('celcom');
  const now = new Date();
  await recoverStale(now);
  let processed = 0;
  for (let i = 0; i < limit; i += 1) {
    const token = crypto.randomBytes(16).toString('hex');
    const row = await SmsMessage.findOneAndUpdate(
      {
        deliveryMode: 'G5_PROTECTED', dispatchMode: 'ENABLED', status: 'queued', sendStartedAt: null,
        $or: [{ nextRetryAt: null }, { nextRetryAt: { $lte: new Date() } }],
      },
      { $set: { status: 'processing', dispatchLeaseToken: token, dispatchLeaseExpiresAt: new Date(Date.now() + PROTECTED_LEASE_MS) } },
      { sort: { priority: -1, createdAt: 1 }, new: true }
    ).select('+payloadEnvelope');
    if (!row) break;
    processed += 1;

    const complete = (set) => SmsMessage.updateOne(
      { _id: row._id, dispatchLeaseToken: token, status: 'processing' },
      { $set: { ...set, dispatchLeaseToken: null, dispatchLeaseExpiresAt: null } }
    );

    let payload;
    try {
      payload = JSON.parse(openEnvelope(row.payloadEnvelope, aadFor(row._id, row.clientId)));
    } catch (err) {
      await complete({ status: 'failed', failedAt: new Date(), failureReason: `envelope_${err.code || 'error'}` });
      continue; // no plaintext fallback
    }

    // Durable marker BEFORE the provider call, conditional on lease ownership.
    const started = await SmsMessage.updateOne(
      { _id: row._id, dispatchLeaseToken: token, status: 'processing', sendStartedAt: null },
      { $set: { sendStartedAt: new Date() } }
    );
    if (started.matchedCount !== 1) continue; // lost the lease; do not send

    let result;
    try {
      result = await provider.send(payload.phone, payload.body, row.idempotencyKey);
    } catch (err) {
      result = { success: false, status: 'unknown', errorMessage: 'provider_exception' };
    }
    if (result.success) {
      await complete({ status: 'sent', sentAt: new Date(), providerMessageId: result.providerMessageId });
    } else if (result.status === 'unknown') {
      await complete({ status: 'unknown', failureReason: String(result.errorMessage || 'unknown').slice(0, 200) });
    } else if (result.retryable && row.retryCount + 1 < row.maxRetries) {
      // provider definitively rejected before accepting: safe to retry
      await SmsMessage.updateOne(
        { _id: row._id, dispatchLeaseToken: token, status: 'processing' },
        { $set: { status: 'queued', sendStartedAt: null, nextRetryAt: new Date(Date.now() + 60_000),
          failureReason: String(result.errorMessage || '').slice(0, 200), dispatchLeaseToken: null, dispatchLeaseExpiresAt: null },
        $inc: { retryCount: 1 } }
      );
    } else {
      await complete({ status: 'failed', failedAt: new Date(), failureReason: String(result.errorMessage || '').slice(0, 200) });
    }
    logger.info({ smsId: String(row._id) }, 'Protected SMS processed');
  }
  return processed;
}
