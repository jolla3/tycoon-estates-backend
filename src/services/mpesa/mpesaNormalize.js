// src/services/mpesa/mpesaNormalize.js
//
// G5.3 — Normalize C2B confirmation and Pull result rows into a common shape.
// Does not post to G3. Does not invent missing provider fields.

import crypto from 'crypto';
import { DARAJA_PROVIDER, INGESTION_SOURCE } from './daraja.constants.js';

/**
 * Parse TransTime forms such as 20231121121325 into a Date (UTC interpretation of local components).
 * Returns null when unparseable — callers must not invent timestamps.
 */
export function parseDarajaTransTime(raw) {
  if (raw == null || raw === '') return null;
  const s = String(raw).trim();
  // YYYYMMDDHHmmss
  if (/^\d{14}$/.test(s)) {
    const year = Number(s.slice(0, 4));
    const month = Number(s.slice(4, 6)) - 1;
    const day = Number(s.slice(6, 8));
    const hour = Number(s.slice(8, 10));
    const minute = Number(s.slice(10, 12));
    const second = Number(s.slice(12, 14));
    const d = new Date(Date.UTC(year, month, day, hour, minute, second));
    return Number.isNaN(d.getTime()) ? null : d;
  }
  const d = new Date(s);
  return Number.isNaN(d.getTime()) ? null : d;
}

/** Amount strings like "60.00" or numbers → integer cents. Null if unsafe. */
export function parseAmountToCents(raw) {
  if (raw == null || raw === '') return null;
  const n = typeof raw === 'number' ? raw : Number(String(raw).replace(/,/g, '').trim());
  if (!Number.isFinite(n) || n < 0) return null;
  const cents = Math.round(n * 100);
  if (!Number.isSafeInteger(cents)) return null;
  return cents;
}

export function stablePayloadDigest(payload) {
  const canonical = JSON.stringify(sortKeys(payload ?? {}));
  return crypto.createHash('sha256').update(canonical, 'utf8').digest('hex');
}

function sortKeys(value) {
  if (Array.isArray(value)) return value.map(sortKeys);
  if (value && typeof value === 'object') {
    const out = {};
    for (const key of Object.keys(value).sort()) {
      out[key] = sortKeys(value[key]);
    }
    return out;
  }
  return value;
}

/**
 * Normalize a C2B confirmation body into a candidate transaction + validation flags.
 * Missing BillRefNumber is allowed for Buy Goods / Till.
 */
export function normalizeC2bConfirmation(body) {
  const payload = body && typeof body === 'object' ? body : {};
  const receiptNumber = payload.TransID != null ? String(payload.TransID).trim() : '';
  const businessShortCode =
    payload.BusinessShortCode != null ? String(payload.BusinessShortCode).trim() : '';
  const amountCents = parseAmountToCents(payload.TransAmount);
  const transactionAt = parseDarajaTransTime(payload.TransTime);
  const billRef =
    payload.BillRefNumber == null || payload.BillRefNumber === ''
      ? null
      : String(payload.BillRefNumber);

  const errors = [];
  if (!receiptNumber) errors.push('missing_receipt');
  if (!businessShortCode) errors.push('missing_shortcode');
  if (amountCents == null) errors.push('invalid_amount');
  if (!transactionAt) errors.push('invalid_trans_time');

  return {
    sourceChannel: INGESTION_SOURCE.C2B_CONFIRMATION,
    provider: DARAJA_PROVIDER,
    receiptNumber,
    businessShortCode,
    amountCents,
    currency: 'KES',
    transactionAt,
    billRefNumber: billRef,
    transactionType: payload.TransactionType != null ? String(payload.TransactionType) : null,
    msisdn: payload.MSISDN != null ? String(payload.MSISDN) : null,
    payerName: [payload.FirstName, payload.MiddleName, payload.LastName]
      .filter((p) => p != null && String(p).trim() !== '')
      .join(' ')
      .trim() || null,
    orgAccountBalance: payload.OrgAccountBalance != null ? String(payload.OrgAccountBalance) : null,
    thirdPartyTransId: payload.ThirdPartyTransID != null ? String(payload.ThirdPartyTransID) : null,
    payloadDigest: stablePayloadDigest(payload),
    validationErrors: errors,
    ok: errors.length === 0,
  };
}

/**
 * Normalize a single Pull Transactions row. Field names vary across secondary docs;
 * accept common aliases without inventing values.
 */
export function normalizePullTransactionRow(row, { sourceChannel = INGESTION_SOURCE.PULL_QUERY } = {}) {
  const payload = row && typeof row === 'object' ? row : {};
  const receiptNumber = String(
    payload.TransID
      ?? payload.TransactionID
      ?? payload.receiptNumber
      ?? payload.MpesaReceiptNumber
      ?? ''
  ).trim();
  const businessShortCode = String(
    payload.BusinessShortCode ?? payload.ShortCode ?? payload.shortCode ?? ''
  ).trim();
  const amountCents = parseAmountToCents(
    payload.TransAmount ?? payload.Amount ?? payload.amount
  );
  const transactionAt = parseDarajaTransTime(
    payload.TransTime ?? payload.TransactionDate ?? payload.transactionDate
  );

  const errors = [];
  if (!receiptNumber) errors.push('missing_receipt');
  if (!businessShortCode) errors.push('missing_shortcode');
  if (amountCents == null) errors.push('invalid_amount');
  if (!transactionAt) errors.push('invalid_trans_time');

  return {
    sourceChannel,
    provider: DARAJA_PROVIDER,
    receiptNumber,
    businessShortCode,
    amountCents,
    currency: 'KES',
    transactionAt,
    billRefNumber:
      payload.BillRefNumber == null || payload.BillRefNumber === ''
        ? null
        : String(payload.BillRefNumber),
    transactionType: payload.TransactionType != null ? String(payload.TransactionType) : null,
    msisdn: payload.MSISDN != null ? String(payload.MSISDN) : null,
    payerName: null,
    orgAccountBalance: null,
    thirdPartyTransId: null,
    payloadDigest: stablePayloadDigest(payload),
    validationErrors: errors,
    ok: errors.length === 0,
  };
}
