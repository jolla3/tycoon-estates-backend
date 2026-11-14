import { describe, test, expect } from '@jest/globals';
import {
  normalizeC2bConfirmation,
  normalizePullTransactionRow,
  parseAmountToCents,
  parseDarajaTransTime,
  isEligibleBuyGoodsTransactionType,
} from '../../../src/services/mpesa/mpesaNormalize.js';

describe('parseAmountToCents (strict decimal)', () => {
  test('accepts whole and two-decimal strings and JSON numbers', () => {
    expect(parseAmountToCents('60')).toBe(6000);
    expect(parseAmountToCents('60.00')).toBe(6000);
    expect(parseAmountToCents('60.25')).toBe(6025);
    expect(parseAmountToCents(168)).toBe(16800);
    expect(parseAmountToCents('0')).toBe(0);
  });
  test('rejects separators, negatives, excess precision, non-numeric', () => {
    expect(parseAmountToCents('1,000.00')).toBeNull();
    expect(parseAmountToCents('-1')).toBeNull();
    expect(parseAmountToCents('60.999')).toBeNull();
    expect(parseAmountToCents('bad')).toBeNull();
    expect(parseAmountToCents('')).toBeNull();
  });
});

describe('parseDarajaTransTime', () => {
  test('parses C2B YYYYMMDDHHmmss as Africa/Nairobi wall time', () => {
    const d = parseDarajaTransTime('20260509182900');
    expect(d).toBeInstanceOf(Date);
    expect(d.toISOString()).toBe('2026-05-09T15:29:00.000Z');
  });
  test('parses Pull ISO-8601 timestamps with an explicit timezone', () => {
    expect(parseDarajaTransTime('2020-08-05T10:13:00Z').toISOString())
      .toBe('2020-08-05T10:13:00.000Z');
    expect(parseDarajaTransTime('2020-08-05T13:13:00+03:00').toISOString())
      .toBe('2020-08-05T10:13:00.000Z');
  });
  test('rejects invalid calendar, clock and timezone-less ISO values', () => {
    expect(parseDarajaTransTime('20260230120000')).toBeNull();
    expect(parseDarajaTransTime('20260509250000')).toBeNull();
    expect(parseDarajaTransTime('2020-02-30T10:13:00Z')).toBeNull();
    expect(parseDarajaTransTime('2020-08-05T10:13:00')).toBeNull();
    expect(parseDarajaTransTime('20260509')).toBeNull();
    expect(parseDarajaTransTime('')).toBeNull();
  });
});

describe('Buy Goods C2B confirmation fixture', () => {
  test('maps provider Buy Goods label to the canonical posting transaction type', () => {
    const n = normalizeC2bConfirmation({
      TransactionType: 'Buy Goods',
      TransID: 'UI5P15DKHW',
      TransTime: '20260509182900',
      TransAmount: '60.00',
      BusinessShortCode: '600987',
      BillRefNumber: '',
      MSISDN: '254712345678',
      FirstName: 'TEST',
    });
    expect(n.ok).toBe(true);
    expect(n.receiptNumber).toBe('UI5P15DKHW');
    expect(n.amountCents).toBe(6000);
    expect(n.billRefNumber).toBeNull();
    expect(n.transactionType).toBe('CustomerBuyGoodsOnline');
    expect(n.validationErrors).toEqual([]);
  });

  test('normalizes Pay Bill but rejects it from the Buy Goods product scope', () => {
    const n = normalizeC2bConfirmation({
      TransactionType: 'Pay Bill',
      TransID: 'PAYBILL123',
      TransTime: '20260509182900',
      TransAmount: '10.00',
      BusinessShortCode: '600987',
    });
    expect(n.transactionType).toBe('CustomerPayBillOnline');
    expect(n.ok).toBe(false);
    expect(n.validationErrors).toContain('unsupported_transaction_type');
  });

  test('accepts the canonical Buy Goods transaction type', () => {
    const n = normalizeC2bConfirmation({
      TransactionType: 'CustomerBuyGoodsOnline',
      TransID: 'X1',
      TransTime: '20260509182900',
      TransAmount: '10.00',
      BusinessShortCode: '600987',
    });
    expect(n.ok).toBe(true);
    expect(n.transactionType).toBe('CustomerBuyGoodsOnline');
  });

  test('rejects missing receipt', () => {
    const n = normalizeC2bConfirmation({
      TransactionType: 'Buy Goods',
      TransAmount: '10.00',
      BusinessShortCode: '600987',
      TransTime: '20260509182900',
    });
    expect(n.ok).toBe(false);
    expect(n.validationErrors).toContain('missing_receipt');
  });
});

describe('transaction type eligibility', () => {
  test('recognizes only Buy Goods transaction types', () => {
    expect(isEligibleBuyGoodsTransactionType('Buy Goods')).toBe(true);
    expect(isEligibleBuyGoodsTransactionType('Buy Goods Online')).toBe(true);
    expect(isEligibleBuyGoodsTransactionType('CustomerBuyGoodsOnline')).toBe(true);
    expect(isEligibleBuyGoodsTransactionType('Pay Bill')).toBe(false);
  });
});

describe('documented TransactionPull row', () => {
  const row = {
    transactionId: 'yzlyrEsRG1',
    trxDate: '2020-08-05T10:13:00Z',
    msisdn: 722000000,
    sender: 'UAT2',
    transactiontype: 'c2b-pay-bill-debit',
    billreference: '37207636392',
    amount: '168.00',
    organizationname: 'Daraja Pull API Test',
  };

  test('maps the documented lowercase field names and shortcode query context', () => {
    const n = normalizePullTransactionRow(row, { businessShortCode: '600987' });
    expect(n.receiptNumber).toBe('yzlyrEsRG1');
    expect(n.businessShortCode).toBe('600987');
    expect(n.amountCents).toBe(16800);
    expect(n.transactionAt.toISOString()).toBe('2020-08-05T10:13:00.000Z');
    expect(n.billRefNumber).toBe('37207636392');
    expect(n.msisdn).toBe('722000000');
    expect(n.transactionType).toBe('CustomerPayBillOnline');
    expect(n.ok).toBe(false);
    expect(n.validationErrors).toContain('unsupported_transaction_type');
  });

  test('requires merchant shortcode context when Pull row does not include shortcode', () => {
    const n = normalizePullTransactionRow(row);
    expect(n.businessShortCode).toBe('');
    expect(n.validationErrors).toContain('missing_shortcode');
  });

  test('rejects a row whose explicit shortcode conflicts with its query profile', () => {
    const n = normalizePullTransactionRow({ ...row, BusinessShortCode: '999999' }, {
      businessShortCode: '600987',
    });
    expect(n.businessShortCode).toBe('999999');
    expect(n.validationErrors).toContain('merchant_shortcode_mismatch');
  });

  test('rejects unknown Pull transaction types rather than treating them as Buy Goods', () => {
    const n = normalizePullTransactionRow({ ...row, transactiontype: 'unverified-credit-type' }, {
      businessShortCode: '600987',
    });
    expect(n.ok).toBe(false);
    expect(n.validationErrors).toContain('unsupported_transaction_type');
  });
});
