// src/utils/g5Token.js
//
// G5 — bearer-token primitives for Tenant submission links.
//
// - 32 random bytes (256 bits) from the OS CSPRNG, base64url (43 chars).
// - Only a one-way HMAC-SHA256 digest is persisted. The raw token is never stored.
// - Digest is keyed (pepper) so a database leak alone cannot be used to test guesses.
// - Comparison is constant-time.

import crypto from 'crypto';

export const TOKEN_BYTES = 32;
export const TOKEN_REGEX = /^[A-Za-z0-9_-]{43}$/;

function pepper() {
  const hex = process.env.G5_LINK_TOKEN_PEPPER || '';
  if (!/^[0-9a-fA-F]{64}$/.test(hex)) {
    const err = new Error('G5_LINK_TOKEN_PEPPER must be 64 hex characters');
    err.code = 'G5_PEPPER_MISSING';
    throw err;
  }
  return Buffer.from(hex, 'hex');
}

export function generateBearerToken() {
  return crypto.randomBytes(TOKEN_BYTES).toString('base64url');
}

export function isWellFormedToken(token) {
  return typeof token === 'string' && TOKEN_REGEX.test(token);
}

export function digestToken(token) {
  if (!isWellFormedToken(token)) {
    const err = new Error('malformed token');
    err.code = 'G5_TOKEN_MALFORMED';
    throw err;
  }
  return crypto.createHmac('sha256', pepper()).update(token, 'utf8').digest('hex');
}

export function digestsEqual(aHex, bHex) {
  if (typeof aHex !== 'string' || typeof bHex !== 'string') return false;
  const a = Buffer.from(aHex, 'hex');
  const b = Buffer.from(bHex, 'hex');
  if (a.length !== b.length || a.length === 0) return false;
  return crypto.timingSafeEqual(a, b);
}
