import { parseMpesaSms, parseMoneyToCents, PARSE_ERROR } from '../../../src/services/mpesa/mpesaSmsParser.js';

// SYNTHETIC fixtures (not real captures). Real-capture verification is gate B04.
const GOOD = 'QJK2ABCDEF Confirmed. Ksh1,250.50 paid to JOHN DOE SHOP. on 20/10/26 at 3:15 PM.New M-PESA balance is Ksh500.00. Transaction cost, Ksh0.00.';

describe('parseMpesaSms', () => {
  test('parses supported template into integer cents and Nairobi time', () => {
    const r = parseMpesaSms(GOOD);
    expect(r.ok).toBe(true);
    expect(r.receiptNumber).toBe('QJK2ABCDEF');
    expect(r.amountCents).toBe(125050);
    expect(Number.isInteger(r.amountCents)).toBe(true);
    expect(r.transactionAt.toISOString()).toBe('2026-10-20T12:15:00.000Z');
    expect(r.timestampSemantics).toBe('SMS_NAIROBI_MINUTE_UNVERIFIED');
  });
  test('does not return payer balance or cost', () => {
    const r = parseMpesaSms(GOOD);
    expect(Object.keys(r).join()).not.toMatch(/balance|cost/i);
  });
  test('whitespace/newline variants are accepted deterministically', () => {
    expect(parseMpesaSms(GOOD.replace('.New', '.\nNew').replace('shop', 'shop')).ok).toBe(true);
  });
  test('rejects empty, oversize, unsupported, multiple', () => {
    expect(parseMpesaSms('').errors).toEqual([PARSE_ERROR.EMPTY]);
    expect(parseMpesaSms(null).ok).toBe(false);
    expect(parseMpesaSms('x'.repeat(1001)).errors).toEqual([PARSE_ERROR.TOO_LONG]);
    expect(parseMpesaSms('hello world').errors).toEqual([PARSE_ERROR.UNSUPPORTED_TEMPLATE]);
    expect(parseMpesaSms(`${GOOD} ${GOOD}`).errors).toEqual([PARSE_ERROR.MULTIPLE_MESSAGES]);
  });
  test('rejects impossible date, bad hour, lowercase receipt, sent-to template, extra payload', () => {
    expect(parseMpesaSms(GOOD.replace('20/10/26', '31/02/26')).errors).toContain(PARSE_ERROR.BAD_DATETIME);
    expect(parseMpesaSms(GOOD.replace('3:15 PM', '13:15 PM')).ok).toBe(false);
    expect(parseMpesaSms(GOOD.replace('QJK2ABCDEF', 'qjk2abcdef')).ok).toBe(false);
    expect(parseMpesaSms(GOOD.replace('paid to', 'sent to')).ok).toBe(false);
    expect(parseMpesaSms(`${GOOD} Click http://evil`).ok).toBe(false);
  });
  test('rejects fractional-cent, missing decimals, zero and unsafe amounts', () => {
    expect(parseMpesaSms(GOOD.replace('1,250.50', '1,250.505')).ok).toBe(false);
    expect(parseMpesaSms(GOOD.replace('1,250.50', '1250')).ok).toBe(false);
    expect(parseMpesaSms(GOOD.replace('1,250.50', '0.00')).errors).toContain(PARSE_ERROR.BAD_AMOUNT);
  });
  test('third-party payer text is irrelevant (no payer fields parsed)', () => {
    expect(parseMpesaSms(GOOD).merchantName).toBe('JOHN DOE SHOP');
  });
  test('parseMoneyToCents strictness', () => {
    expect(parseMoneyToCents('0.01')).toBe(1);
    expect(parseMoneyToCents('1,000.00')).toBe(100000);
    for (const bad of ['1,00.00', '-5.00', '1e3.00', '12', '1.5', '', '9007199254740993.00']) expect(parseMoneyToCents(bad)).toBeNull();
  });
});
