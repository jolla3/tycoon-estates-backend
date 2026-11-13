// src/utils/g5Envelope.js
//
// G5 — versioned authenticated-encryption envelope for protected evidence
// (submitted M-PESA SMS text, protected SMS outbox payloads).
//
// Format:  g5e1.<keyId>.<ivB64url>.<tagB64url>.<ctB64url>
// Cipher:  AES-256-GCM, 96-bit random IV, caller-supplied AAD (binds the
//          ciphertext to its owning record so it cannot be swapped between rows).
// Keys:    G5_ENVELOPE_KEYS = "k1:<64hex>,k0:<64hex>" — first entry is the active
//          encryption key; all entries can decrypt (rotation). Dedicated to G5 and
//          deliberately separate from ENCRYPTION_KEY / BANK_SECRETS_ENCRYPTION_KEY.

import crypto from 'crypto';

const VERSION = 'g5e1';

function loadKeys() {
  const raw = process.env.G5_ENVELOPE_KEYS || '';
  const keys = new Map();
  let activeId = null;
  for (const part of raw.split(',').map((s) => s.trim()).filter(Boolean)) {
    const [id, hex] = part.split(':');
    if (!/^[A-Za-z0-9_-]{1,16}$/.test(id || '') || !/^[0-9a-fA-F]{64}$/.test(hex || '')) {
      const err = new Error('G5_ENVELOPE_KEYS entry is malformed (expected id:64hex)');
      err.code = 'G5_ENVELOPE_KEY_INVALID';
      throw err;
    }
    keys.set(id, Buffer.from(hex, 'hex'));
    if (!activeId) activeId = id;
  }
  if (!activeId) {
    const err = new Error('G5_ENVELOPE_KEYS is not configured');
    err.code = 'G5_ENVELOPE_KEY_MISSING';
    throw err;
  }
  return { keys, activeId };
}

function aadBuffer(aad) {
  if (typeof aad !== 'string' || !aad.length) {
    const err = new Error('envelope AAD is required');
    err.code = 'G5_ENVELOPE_AAD_REQUIRED';
    throw err;
  }
  return Buffer.from(aad, 'utf8');
}

export function sealEnvelope(plaintext, aad) {
  const { keys, activeId } = loadKeys();
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', keys.get(activeId), iv);
  cipher.setAAD(aadBuffer(aad));
  const ct = Buffer.concat([cipher.update(String(plaintext), 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return [VERSION, activeId, iv.toString('base64url'), tag.toString('base64url'), ct.toString('base64url')].join('.');
}

export function openEnvelope(envelope, aad) {
  const parts = String(envelope || '').split('.');
  if (parts.length !== 5 || parts[0] !== VERSION) {
    const err = new Error('unsupported envelope');
    err.code = 'G5_ENVELOPE_INVALID';
    throw err;
  }
  const { keys } = loadKeys();
  const key = keys.get(parts[1]);
  if (!key) {
    const err = new Error('envelope key id unknown');
    err.code = 'G5_ENVELOPE_KEY_UNKNOWN';
    throw err;
  }
  const decipher = crypto.createDecipheriv('aes-256-gcm', key, Buffer.from(parts[2], 'base64url'));
  decipher.setAAD(aadBuffer(aad));
  decipher.setAuthTag(Buffer.from(parts[3], 'base64url'));
  try {
    return Buffer.concat([
      decipher.update(Buffer.from(parts[4], 'base64url')),
      decipher.final(),
    ]).toString('utf8');
  } catch {
    const err = new Error('envelope authentication failed');
    err.code = 'G5_ENVELOPE_AUTH_FAILED';
    throw err;
  }
}

export function envelopeKeyId(envelope) {
  const parts = String(envelope || '').split('.');
  return parts.length === 5 && parts[0] === VERSION ? parts[1] : null;
}

/**
 * Keyed digest for duplicate detection without storing plaintext.
 * Uses its own key (G5_EVIDENCE_DIGEST_KEY, 64 hex) so envelope key rotation
 * does not invalidate duplicate detection.
 */
export function evidenceDigest(plaintext) {
  const hex = process.env.G5_EVIDENCE_DIGEST_KEY || '';
  if (!/^[0-9a-fA-F]{64}$/.test(hex)) {
    const err = new Error('G5_EVIDENCE_DIGEST_KEY must be 64 hex characters');
    err.code = 'G5_DIGEST_KEY_MISSING';
    throw err;
  }
  return crypto.createHmac('sha256', Buffer.from(hex, 'hex')).update(String(plaintext), 'utf8').digest('hex');
}
