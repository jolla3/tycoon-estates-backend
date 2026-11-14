// src/services/mpesa/mpesaNormalize.js
//
// G5.3 — Normalize C2B confirmation and Pull result rows into a common shape.
// Does not post to G3. Does not invent missing provider fields.

import crypto from 'crypto';
import { DARAJA_PROVIDER, INGESTION_SOURCE } from './daraja.constants.js';

/** Africa/Nairobi is fixed UTC+3 with no DST (Tycoon business-time convention). */
const NAIROBI_OFFSET_MS = 3 * 60 * 60 * 1000;

export function parseDarajaTransTime(raw) {
  if (raw == null || raw === '') return null;
  const s = String(raw).trim();
  if (!/^\d{14}$/.test(s)) return null;
  const year = Number(s.slice(0, 4));
  const month = Number(s.slice(4, 6));
  const day = Number(s.slice(6, 8));
  const hour = Number(s.slice(8, 10));
  const minute = Number(s.slice(10, 12));
  const second = Number(s.slice(12, 14));
  if (!Number.isInteger(year) || year < 2000 || year > 2100) return null;
  if (!Number.isInteger(month) || month < 1 || month > 12) return null;
  if (!Number.isInteger(day) || day < 1 || day > 31) return null;
  if (!Number.isInteger(hour) || hour > 23) return null;
  if (!Number.isInteger(minute) || minute > 59) return null;
  if (!Number.isInteger(second) || second > 59) return null;
  const asUtcProbe = Date.UTC(year, month - 1, day, hour, minute, second);
  const probe = new Date(asUtcProbe);
  if (
    probe.getUTCFullYear() !== year
    || probe.getUTCMonth() !== month - 1
    || probe.getUTCDate() !== day
    || probe.getUTCHours() !== hour
    || probe.getUTCMinutes() !== minute
    || probe.getUTCSeconds() !== second
  ) {
    return null;
  }
  return new Date(asUtcProbe - NAIROBI_OFFSET_MS);
}

export function parseAmountToCents(raw) {
  if (raw == null || raw === '') return null;
  if (typeof raw === 'number') {
    if (!Number.isFinite(raw) || raw < 0) return null;
    return parseAmountToCents(String(raw));
  }
  if (typeof raw !== 'string') return null;
  const s = raw.trim();
  if (!/^\d+(\.\d{1,2})?$/.test(s)) return null;
  const [wholePart, fracPart = ''] = s.split('.');
  if (wholePart.length > 12) return null;
  const whole = Number(wholePart);
  if (!Number.isSafeInteger(whole) || whole < 0) return null;
  const fracPadded = (fracPart + '00').slice(0, 2);
  const frac = Number(fracPadded);
  if (!Number.isInteger(frac) || frac < 0 || frac > 99) return null;
  const cents = whole * 100 + frac;
  if (!Number.isSafeInteger(cents) || cents < 0) return null;
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
    for (const key of Object.keys(value).sort()) out[key] = sortKeys(value[key]);
    return out;
  }
  return value;
}

export const BUY_GOODS_TRANSACTION_TYPES = Object.freeze([
  'Buy Goods',
  'Buy Goods Online',
  'Pay Bill',
]);

export function isEligibleBuyGoodsTransactionType(transactionType) {
  if (transactionType == null || transactionType === '') return false;
  const normalized = String(transactionType).trim().toLowerCase();
  return BUY_GOODS_TRANSACTION_TYPES.some((t) => t.toLowerCase() === normalized);
}

export function normalizeC2bConfirmation(body) {
  const payload = body && typeof body === 'object' ? body : {};
  const receiptNumber = payload.TransID != null ? String(payload.TransID).trim() : '';
  const businessShortCode =
    payload.BusinessShortCode != null ? String(payload.BusinessShortCode).trim() : '';
  const amountCents = parseAmountToCents(payload.TransAmount);
  const transactionAt = parseDarajaTransTime(payload.TransTime);
  const billRef =
    payload.BillRefNumber == null || String(payload.BillRefNumber).trim() === ''
      ? null
      : String(payload.BillRefNumber);
  const transactionType =
    payload.TransactionType != null ? String(payload.TransactionType).trim() : null;
  const errors = [];
  if (!receiptNumber) errors.push('missing_receipt');
  if (!businessShortCode) errors.push('missing_shortcode');
  if (amountCents == null) errors.push('invalid_amount');
  if (!transactionAt) errors.push('invalid_trans_time');
  if (!transactionType) errors.push('missing_transaction_type');
  else if (!isEligibleBuyGoodsTransactionType(transactionType)) {
    errors.push('unsupported_transaction_type');
  }
  return {
    sourceChannel: INGESTION_SOURCE.C2B_CONFIRMATION,
    provider: DARAJA_PROVIDER,
    receiptNumber,
    businessShortCode,
    amountCents,
    currency: 'KES',
    transactionAt,
    billRefNumber: billRef,
    transactionType,
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
    rawFieldNames: Object.keys(payload),
  };
}

export function normalizePullTransactionRow(row, { sourceChannel = INGESTION_SOURCE.PULL_QUERY } = {}) {
  const payload = row && typeof row === 'object' ? row : {};
  const receiptNumber =
    payload.TransID != null
      ? String(payload.TransID).trim()
      : payload.TransactionID != null
        ? String(payload.TransactionID).trim()
        : '';
  const businessShortCode =
    payload.BusinessShortCode != null
      ? String(payload.BusinessShortCode).trim()
      : payload.ShortCode != null
        ? String(payload.ShortCode).trim()
        : '';
  const amountCents = parseAmountToCents(
    payload.TransAmount != null ? payload.TransAmount : payload.Amount
  );
  const transactionAt = parseDarajaTransTime(
    payload.TransTime != null ? payload.TransTime : payload.TransactionDate
  );
  const transactionType =
    payload.TransactionType != null ? String(payload.TransactionType).trim() : null;
  const errors = [];
  if (!receiptNumber) errors.push('missing_receipt');
  if (!businessShortCode) errors.push('missing_shortcode');
  if (amountCents == null) errors.push('invalid_amount');
  if (!transactionAt) errors.push('invalid_trans_time');
  if (transactionType && !isEligibleBuyGoodsTransactionType(transactionType)) {
    errors.push('unsupported_transaction_type');
  }
  return {
    sourceChannel,
    provider: DARAJA_PROVIDER,
    receiptNumber,
    businessShortCode,
    amountCents,
    currency: 'KES',
    transactionAt,
    billRefNumber:
      payload.BillRefNumber == null || String(payload.BillRefNumber).trim() === ''
        ? null
        : String(payload.BillRefNumber),
    transactionType,
    msisdn: payload.MSISDN != null ? String(payload.MSISDN) : null,
    payerName: null,
    orgAccountBalance: null,
    thirdPartyTransId: null,
    payloadDigest: stablePayloadDigest(payload),
    validationErrors: errors,
    ok: errors.length === 0,
    rawFieldNames: Object.keys(payload),
  };
}
