// src/utils/mpesaCollectionReference.js
//
// PayBill collection references (what a tenant types as the account number).
// Format (PROPOSED, see docs/provider-contracts/G5_DARAJA_C2B_PULL_EVIDENCE.md):
//   "T" + 8 Crockford base-32 characters + 1 check character = 10 characters.
// Safaricom documents BillRefNumber as "Alpha-numeric, up to 20 chars", so the
// reference is well inside the provider limit. The check character only catches
// typing mistakes; it is NOT a secret and NOT authentication.
//
// Normalization is strict: trim, uppercase, drop spaces/hyphens, fold O->0 and
// I/L->1. Anything that is not then a well-formed reference is "malformed" and
// must stay unallocated. There is no fuzzy matching.

import crypto from 'crypto';

export const REFERENCE_PREFIX = 'T';
export const REFERENCE_BODY_LENGTH = 8;
export const REFERENCE_LENGTH = 1 + REFERENCE_BODY_LENGTH + 1;
// Crockford base-32 (no I, L, O, U). Index doubles as the check-symbol value.
export const REFERENCE_ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
export const PROVIDER_BILLREF_MAX_LENGTH = 20;

const RE_WELL_FORMED = new RegExp(`^${REFERENCE_PREFIX}[${REFERENCE_ALPHABET}]{${REFERENCE_BODY_LENGTH}}[${REFERENCE_ALPHABET}]$`);

function checkChar(body) {
  // Weighted sum mod 32; weights 1..n catch single-character and most adjacent swaps.
  let sum = 0;
  for (let i = 0; i < body.length; i += 1) {
    sum += (i + 1) * REFERENCE_ALPHABET.indexOf(body[i]);
  }
  return REFERENCE_ALPHABET[sum % 32];
}

/**
 * Normalize a provider-supplied BillRefNumber. Returns
 * { status: 'missing'|'malformed'|'ok', reference }.
 */
export function normalizeCollectionReference(raw) {
  if (raw == null) return { status: 'missing', reference: null };
  const trimmed = String(raw).trim();
  if (!trimmed) return { status: 'missing', reference: null };
  if (trimmed.length > PROVIDER_BILLREF_MAX_LENGTH) return { status: 'malformed', reference: null };
  const folded = trimmed
    .toUpperCase()
    .replace(/[\s-]+/g, '')
    .replace(/O/g, '0')
    .replace(/[IL]/g, '1');
  if (!RE_WELL_FORMED.test(folded)) return { status: 'malformed', reference: null };
  const body = folded.slice(1, 1 + REFERENCE_BODY_LENGTH);
  if (folded[folded.length - 1] !== checkChar(body)) return { status: 'malformed', reference: null };
  return { status: 'ok', reference: folded };
}

/** Generate a candidate reference using a CSPRNG. Uniqueness is enforced by the DB index. */
export function generateCollectionReference(randomBytes = crypto.randomBytes) {
  const bytes = randomBytes(REFERENCE_BODY_LENGTH);
  let body = '';
  for (let i = 0; i < REFERENCE_BODY_LENGTH; i += 1) {
    body += REFERENCE_ALPHABET[bytes[i] & 31]; // 256 % 32 === 0 => unbiased
  }
  return `${REFERENCE_PREFIX}${body}${checkChar(body)}`;
}

/** Human-friendly display, e.g. T1234-5678-9 (separators are ignored on input). */
export function formatCollectionReference(reference) {
  if (!reference || reference.length !== REFERENCE_LENGTH) return reference;
  return `${reference.slice(0, 5)}-${reference.slice(5, 9)}-${reference.slice(9)}`;
}
