// src/services/mpesa/mpesaSmsParser.js
//
// G5 — deterministic parser for submitted M-PESA confirmation SMS text.
//
// Rules:
//  * Exact, versioned template registry. No fuzzy matching, no inference.
//  * Anything unsupported, truncated, ambiguous or containing extra payload is rejected.
//  * Strict integer-cent parsing (no floats anywhere).
//  * Fields that are not needed for matching (payer balance, transaction cost) are
//    validated structurally but NOT returned, so they cannot leak into storage.
//  * Output is SUBMITTED evidence only. It never proves a payment happened; the
//    matcher must still find a provider-verified canonical receipt.
//
// Template provenance: BUY_GOODS_PAID_V1 follows the customer-to-merchant Buy Goods
// confirmation wording commonly delivered to payers. Fixtures under tests/ are
// SYNTHETIC examples of that wording, not captured production SMS. Real-capture
// verification is tracked as a release gate (see G5 guardrails, B04).

import { dateUtil } from '../../utils/date.js';

export const PARSER_VERSION = 'mpesa-sms-parser/1';

export const SMS_TEMPLATE = Object.freeze({
  BUY_GOODS_PAID_V1: 'BUY_GOODS_PAID_V1',
});

export const PARSE_ERROR = Object.freeze({
  EMPTY: 'empty_input',
  TOO_LONG: 'input_too_long',
  UNSUPPORTED_TEMPLATE: 'unsupported_template',
  MULTIPLE_MESSAGES: 'multiple_messages',
  BAD_AMOUNT: 'invalid_amount',
  BAD_DATETIME: 'invalid_datetime',
  BAD_RECEIPT: 'invalid_receipt',
});

const MAX_INPUT_CHARS = 1000;
const MONEY = String.raw`(?:\d{1,3}(?:,\d{3})+|\d+)\.\d{2}`;
const BUY_GOODS_PAID_V1 = new RegExp(
  '^([A-Z0-9]{10}) Confirmed\\. '
  + `Ksh(${MONEY}) paid to ([^\\n]{1,80}?)\\. `
  + 'on (\\d{1,2})/(\\d{1,2})/(\\d{2}) at (\\d{1,2}):(\\d{2}) (AM|PM)\\.? ?'
  + `New M-PESA balance is Ksh${MONEY}\\. `
  + `Transaction cost, Ksh${MONEY}\\.?$`
);

function normalizeWhitespace(text) {
  return String(text).replace(/\r\n?/g, '\n').replace(/[ \t]+/g, ' ').replace(/ ?\n ?/g, ' ').trim();
}

export function parseMoneyToCents(text) {
  const m = /^(?:(\d{1,3}(?:,\d{3})+)|(\d+))\.(\d{2})$/.exec(String(text));
  if (!m) return null;
  const whole = (m[1] || m[2]).replace(/,/g, '');
  const cents = Number(whole) * 100 + Number(m[3]);
  return Number.isSafeInteger(cents) && cents > 0 ? cents : null;
}

function toNairobiDate(dd, mm, yy, hh, mi, ap) {
  const day = Number(dd);
  const month = Number(mm);
  const year = 2000 + Number(yy);
  let hour = Number(hh);
  const minute = Number(mi);
  if (month < 1 || month > 12 || day < 1 || day > 31) return null;
  if (hour < 1 || hour > 12 || minute > 59) return null;
  if (ap === 'AM') hour = hour === 12 ? 0 : hour;
  else hour = hour === 12 ? 12 : hour + 12;
  const iso = `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`
    + `T${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')}:00+03:00`;
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return null;
  // Reject impossible calendar dates (e.g. 31/02) that Date would roll over.
  if (dateUtil.format(d, 'D-M-YYYY') !== `${day}-${month}-${year}`) return null;
  return d;
}

/**
 * @returns {{ ok: boolean, parserVersion: string, template: string|null,
 *             receiptNumber?: string, amountCents?: number, currency?: string,
 *             merchantName?: string, transactionAt?: Date,
 *             timestampSemantics?: string, errors: string[] }}
 */
export function parseMpesaSms(rawText) {
  const base = { parserVersion: PARSER_VERSION, template: null, errors: [] };
  if (typeof rawText !== 'string' || !rawText.trim()) {
    return { ok: false, ...base, errors: [PARSE_ERROR.EMPTY] };
  }
  if (rawText.length > MAX_INPUT_CHARS) {
    return { ok: false, ...base, errors: [PARSE_ERROR.TOO_LONG] };
  }

  const text = normalizeWhitespace(rawText);
  // A paste containing more than one confirmation is ambiguous: reject, never pick one.
  if ((text.match(/ Confirmed\./g) || []).length !== 1) {
    const multiple = (text.match(/ Confirmed\./g) || []).length > 1;
    return {
      ok: false,
      ...base,
      errors: [multiple ? PARSE_ERROR.MULTIPLE_MESSAGES : PARSE_ERROR.UNSUPPORTED_TEMPLATE],
    };
  }

  const m = BUY_GOODS_PAID_V1.exec(text);
  if (!m) return { ok: false, ...base, errors: [PARSE_ERROR.UNSUPPORTED_TEMPLATE] };

  const [, receipt, money, merchant, dd, mm, yy, hh, mi, ap] = m;
  const errors = [];
  const amountCents = parseMoneyToCents(money);
  if (amountCents == null) errors.push(PARSE_ERROR.BAD_AMOUNT);
  const transactionAt = toNairobiDate(dd, mm, yy, hh, mi, ap);
  if (!transactionAt) errors.push(PARSE_ERROR.BAD_DATETIME);
  if (!/^[A-Z0-9]{10}$/.test(receipt)) errors.push(PARSE_ERROR.BAD_RECEIPT);
  if (errors.length) {
    return { ok: false, ...base, template: SMS_TEMPLATE.BUY_GOODS_PAID_V1, errors };
  }

  return {
    ok: true,
    parserVersion: PARSER_VERSION,
    template: SMS_TEMPLATE.BUY_GOODS_PAID_V1,
    receiptNumber: receipt,
    amountCents,
    currency: 'KES',
    merchantName: merchant.trim().replace(/\s+/g, ' ').toUpperCase(),
    transactionAt,
    // SMS clock is Nairobi local time to the minute. Provider timestamp semantics
    // are unverified (B04), so this is carried as evidence, never as proof.
    timestampSemantics: 'SMS_NAIROBI_MINUTE_UNVERIFIED',
    errors: [],
  };
}
