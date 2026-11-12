// src/services/banking/callbackQuarantine.service.js

import crypto from 'crypto';
import { BankCallbackQuarantine } from '../../models/BankCallbackQuarantine.js';

const SENSITIVE_KEY = /(secret|password|token|authorization|credential|basic)/i;

function redact(value, depth = 0) {
  if (depth > 6) return '[truncated]';
  if (value == null) return value;
  if (Array.isArray(value)) return value.slice(0, 20).map((v) => redact(v, depth + 1));
  if (typeof value === 'object') {
    const out = {};
    for (const [k, v] of Object.entries(value)) {
      if (SENSITIVE_KEY.test(k)) {
        out[k] = '[redacted]';
      } else {
        out[k] = redact(v, depth + 1);
      }
    }
    return out;
  }
  if (typeof value === 'string' && value.length > 500) return `${value.slice(0, 500)}…`;
  return value;
}

export function digestPayload(body) {
  const canonical = typeof body === 'string' ? body : JSON.stringify(body ?? {});
  return crypto.createHash('sha256').update(canonical).digest('hex');
}

/**
 * Persist a quarantine record. Returns the document.
 * Callers must treat successful quarantine as durable acceptance for ACK purposes.
 */
export async function quarantineCallbackEvent({
  provider,
  category,
  reason,
  body,
  clientId = null,
  estateId = null,
  bankAccountId = null,
  connectionId = null,
  providerTransactionId = null,
  sourceChannel = 'webhook',
}) {
  const payloadDigest = digestPayload(body);
  const payloadRedacted = redact(body);

  const doc = await BankCallbackQuarantine.create({
    provider,
    category,
    reason: String(reason || 'unspecified').slice(0, 500),
    payloadDigest,
    payloadRedacted,
    clientId,
    estateId,
    bankAccountId,
    connectionId,
    providerTransactionId: providerTransactionId ? String(providerTransactionId) : null,
    sourceChannel,
    status: 'open',
    receivedAt: new Date(),
  });

  return doc;
}

export const callbackQuarantineService = {
  quarantineCallbackEvent,
  digestPayload,
  redact,
};
