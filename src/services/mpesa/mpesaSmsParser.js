// src/services/mpesa/mpesaSmsParser.js
//
// G5 — deterministic parser for submitted M-PESA confirmation SMS text.
//
// Rules:
//  * Exact, versioned template registry. No fuzzy matching, inference or LLM parsing.
//  * Known informational suffixes are allowlisted per template version; unknown payload is rejected.
//  * Strict integer-cent parsing (no floats anywhere).
//  * Payer balance, transaction cost, daily limit and promotional URL are validated structurally
//    where applicable, but are not returned or used as payment identity fields.
//  * Output is SUBMITTED evidence only. It never proves a payment happened; the matcher must still
//    find a provider-verified canonical receipt.
//
// Template provenance: V1 is the original core confirmation shape. V2 is the same transaction core
// with the observed daily transaction-limit sentence and/or Safaricom balances short link suffix.
// V2's structural fixture is sanitized from an owner-supplied SMS capture. Timestamp semantics and
// matching tolerance remain blocked under G5-B04; this parser does not resolve that gate.

import { dateUtil } from '../../utils/date.js';

export const PARSER_VERSION = 'mpesa-sms-parser/2';

export const SMS_TEMPLATE = Object.freeze({
  BUY_GOODS_PAID_V1: 'BUY_GOODS_PAID_V1',
  BUY_GOODS_PAID_V2: 'BUY_GOODS_PAID_V2',
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

// Match the payment-bearing confirmation prefix. The remainder is validated separately so
// recognized provider informational text does not hide a valid receipt, while arbitrary text
// still fails closed.
const BUY_GOODS_PAID_CORE = new RegExp(
  '^([A-Z0-9]{10}) Confirmed\\. '
  + `Ksh(${MONEY}) paid to ([^\\n]{1,80}?)\\. `
  + 'on (\\d{1,2})/(\\d{1,2})/(\\d{2}) at (\\d{1,2}):(\\d{2}) (AM|PM)\\.? ?'
  + `New M-PESA balance is Ksh${MONEY}\\. `
  + `Transaction cost, Ksh${MONEY}\\.?`
);

// Safaricom informational suffix observed after the transaction cost. The daily limit is not
// prefixed with Ksh in the supplied capture. The short link is recognized by exact host; it is
// never resolved, fetched, stored as a parsed field or treated as payment evidence.
const BUY_GOODS_PAID_V2_SUFFIX = new RegExp(
  `^(?:Amount you can transact within the day is ${MONEY}\\.?)?`
  + '(?: ?See all your balances now https:\\/\\/saf\\.cx\\/[A-Za-z0-9_-]{3,64})?\\.?$',
  'i'
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
  const confirmations = (text.match(/ Confirmed\./g) || []).length;
  if (confirmations !== 1) {
    return {
      ok: false,
      ...base,
      errors: [confirmations > 1 ? PARSE_ERROR.MULTIPLE_MESSAGES : PARSE_ERROR.UNSUPPORTED_TEMPLATE],
    };
  }

  const m = BUY_GOODS_PAID_CORE.exec(text);
  if (!m) return { ok: false, ...base, errors: [PARSE_ERROR.UNSUPPORTED_TEMPLATE] };

  const suffix = text.slice(m[0].length).trim();
  if (suffix && !BUY_GOODS_PAID_V2_SUFFIX.test(suffix)) {
    return { ok: false, ...base, errors: [PARSE_ERROR.UNSUPPORTED_TEMPLATE] };
  }

  const [, receipt, money, merchant, dd, mm, yy, hh, mi, ap] = m;
  const template = suffix ? SMS_TEMPLATE.BUY_GOODS_PAID_V2 : SMS_TEMPLATE.BUY_GOODS_PAID_V1;
  const errors = [];
  const amountCents = parseMoneyToCents(money);
  if (amountCents == null) errors.push(PARSE_ERROR.BAD_AMOUNT);
  const transactionAt = toNairobiDate(dd, mm, yy, hh, mi, ap);
  if (!transactionAt) errors.push(PARSE_ERROR.BAD_DATETIME);
  if (!/^[A-Z0-9]{10}$/.test(receipt)) errors.push(PARSE_ERROR.BAD_RECEIPT);
  if (errors.length) return { ok: false, ...base, template, errors };

  return {
    ok: true,
    parserVersion: PARSER_VERSION,
    template,
    receiptNumber: receipt,
    amountCents,
    currency: 'KES',
    merchantName: merchant.trim().replace(/\s+/g, ' ').toUpperCase(),
    transactionAt,
    // Current parser interprets this SMS date as DD/MM/YY + Nairobi local time. B04 remains open:
    // the provider/SMS timestamp correspondence and matching tolerance are not yet verified.
    timestampSemantics: 'SMS_NAIROBI_MINUTE_UNVERIFIED',
    errors: [],
  };
}
