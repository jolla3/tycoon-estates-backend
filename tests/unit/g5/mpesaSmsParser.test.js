import { parseMpesaSms, parseMoneyToCents, PARSE_ERROR, SMS_TEMPLATE, PARSER_VERSION } from '../../../src/services/mpesa/mpesaSmsParser.js';

// Synthetic core fixture. Timestamp semantics and provider correspondence remain B04.
const GOOD = 'QJK2ABCDEF Confirmed. Ksh1,250.50 paid to JOHN DOE SHOP. on 20/10/26 at 3:15 PM.New M-PESA balance is Ksh500.00. Transaction cost, Ksh0.00.';
// Sanitized structure derived from an owner-supplied Safaricom capture, including its informational footer.
const GOOD_WITH_INFORMATIONAL_SUFFIX = GOOD
  + ' Amount you can transact within the day is 499,890.00. See all your balances now https://saf.cx/kWQpy';

describe('parseMpesaSms', () => {
  test('reports the current parser version and parses the V1 core into integer cents and Nairobi time', () => {
    const r = parseMpesaSms(GOOD);
    expect(r.ok).toBe(true);
    expect(r.parserVersion).toBe(PARSER_VERSION);
    expect(r.template).toBe(SMS_TEMPLATE.BUY_GOODS_PAID_V1);
    expect(r.receiptNumber).toBe('QJK2ABCDEF');
    expect(r.amountCents).toBe(125050);
    expect(Number.isInteger(r.amountCents)).toBe(true);
    expect(r.transactionAt.toISOString()).toBe('2026-10-20T12:15:00.000Z');
    expect(r.timestampSemantics).toBe('SMS_NAIROBI_MINUTE_UNVERIFIED');
  });

  test('accepts the allowlisted daily-limit and Safaricom balances-link suffix without parsing its amounts', () => {
    const r = parseMpesaSms(GOOD_WITH_INFORMATIONAL_SUFFIX);
    expect(r.ok).toBe(true);
    expect(r.template).toBe(SMS_TEMPLATE.BUY_GOODS_PAID_V2);
    expect(r.receiptNumber).toBe('QJK2ABCDEF');
    expect(r.amountCents).toBe(125050);
    expect(Object.keys(r).join()).not.toMatch(/balance|cost|daily|limit|url|link/i);
  });

  test.each([
    ['daily limit only', `${GOOD} Amount you can transact within the day is 499,890.00.`],
    ['Safaricom balances link only', `${GOOD} See all your balances now https://saf.cx/kWQpy`],
  ])('accepts the known V2 suffix variant: %s', (_label, text) => {
    const r = parseMpesaSms(text);
    expect(r.ok).toBe(true);
    expect(r.template).toBe(SMS_TEMPLATE.BUY_GOODS_PAID_V2);
  });

  test('does not return payer balance, transaction cost, daily limit or promotional URL', () => {
    const r = parseMpesaSms(GOOD_WITH_INFORMATIONAL_SUFFIX);
    expect(Object.keys(r).join()).not.toMatch(/balance|cost|daily|limit|url|link/i);
  });

  test('whitespace/newline variants are accepted deterministically', () => {
    expect(parseMpesaSms(GOOD.replace('.New', '.\nNew')).ok).toBe(true);
    expect(parseMpesaSms(GOOD_WITH_INFORMATIONAL_SUFFIX.replace('. Amount', '.\nAmount')).ok).toBe(true);
  });

  test('rejects empty, oversize, unsupported, and multiple messages', () => {
    expect(parseMpesaSms('').errors).toEqual([PARSE_ERROR.EMPTY]);
    expect(parseMpesaSms(null).ok).toBe(false);
    expect(parseMpesaSms('x'.repeat(1001)).errors).toEqual([PARSE_ERROR.TOO_LONG]);
    expect(parseMpesaSms('hello world').errors).toEqual([PARSE_ERROR.UNSUPPORTED_TEMPLATE]);
    expect(parseMpesaSms(`${GOOD} ${GOOD}`).errors).toEqual([PARSE_ERROR.MULTIPLE_MESSAGES]);
  });

  test('rejects unknown trailing text and non-Safaricom links', () => {
    expect(parseMpesaSms(`${GOOD} Click http://evil`).ok).toBe(false);
    expect(parseMpesaSms(`${GOOD} See all your balances now https://evil.example/kWQpy`).ok).toBe(false);
    expect(parseMpesaSms(`${GOOD} Amount you can transact within the day is 499,99.00.`).ok).toBe(false);
    expect(parseMpesaSms(`${GOOD} some unrecognized provider notice`).ok).toBe(false);
  });

  test('rejects impossible date, bad hour, lowercase receipt and unsupported wording', () => {
    expect(parseMpesaSms(GOOD.replace('20/10/26', '31/02/26')).errors).toContain(PARSE_ERROR.BAD_DATETIME);
    expect(parseMpesaSms(GOOD.replace('3:15 PM', '13:15 PM')).ok).toBe(false);
    expect(parseMpesaSms(GOOD.replace('QJK2ABCDEF', 'qjk2abcdef')).ok).toBe(false);
    expect(parseMpesaSms(GOOD.replace('paid to', 'sent to')).ok).toBe(false);
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
