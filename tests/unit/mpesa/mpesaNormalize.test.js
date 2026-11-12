import { describe, test, expect } from '@jest/globals';
import {
  normalizeC2bConfirmation,
  normalizePullTransactionRow,
  parseAmountToCents,
  parseDarajaTransTime,
  isEligibleBuyGoodsTransactionType,
} from '../../../src/services/mpesa/mpesaNormalize.js';

describe('parseAmountToCents (strict decimal)', () => {
  test('accepts whole and two-decimal strings', () => {
    expect(parseAmountToCents('60')).toBe(6000);
    expect(parseAmountToCents('60.00')).toBe(6000);
    expect(parseAmountToCents('60.25')).toBe(6025);
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

describe('parseDarajaTransTime (Nairobi wall → UTC)', () => {
  test('parses valid YYYYMMDDHHmmss', () => {
    const d = parseDarajaTransTime('20260509182900');
    expect(d).toBeInstanceOf(Date);
    expect(d.getUTCFullYear()).toBe(2026);
    expect(d.getUTCMonth()).toBe(4);
    expect(d.getUTCDate()).toBe(9);
    expect(d.getUTCHours()).toBe(15);
    expect(d.getUTCMinutes()).toBe(29);
  });
  test('rejects invalid calendar and clock components', () => {
    expect(parseDarajaTransTime('20260230120000')).toBeNull();
    expect(parseDarajaTransTime('20260509250000')).toBeNull();
    expect(parseDarajaTransTime('20260509')).toBeNull();
    expect(parseDarajaTransTime('')).toBeNull();
  });
});

describe('Buy Goods C2B confirmation fixture', () => {
  test('accepts null BillRefNumber and Buy Goods TransactionType', () => {
    const n = normalizeC2bConfirmation({
      TransactionType: 'Buy Goods',
      TransID: 'UI5P15DKHW',
      TransTime: '20260509182900',
      TransAmount: '60.00',
      BusinessShortCode: '123456',
      BillRefNumber: '',
      MSISDN: '254712345678',
      FirstName: 'TEST',
    });
    expect(n.ok).toBe(true);
    expect(n.receiptNumber).toBe('UI5P15DKHW');
    expect(n.amountCents).toBe(6000);
    expect(n.billRefNumber).toBeNull();
    expect(n.transactionType).toBe('Buy Goods');
    expect(n.validationErrors).toEqual([]);
  });

  test('rejects simulator CommandID as TransactionType', () => {
    const n = normalizeC2bConfirmation({
      TransactionType: 'CustomerBuyGoodsOnline',
      TransID: 'X1',
      TransTime: '20260509182900',
      TransAmount: '10.00',
      BusinessShortCode: '1',
      BillRefNumber: '',
    });
    expect(n.ok).toBe(false);
    expect(n.validationErrors).toContain('unsupported_transaction_type');
  });

  test('rejects missing receipt', () => {
    const n = normalizeC2bConfirmation({
      TransactionType: 'Buy Goods',
      TransAmount: '10.00',
      BusinessShortCode: '123456',
      TransTime: '20260509182900',
    });
    expect(n.ok).toBe(false);
    expect(n.validationErrors).toContain('missing_receipt');
  });
});

describe('transaction type eligibility', () => {
  test('recognizes Buy Goods labels', () => {
    expect(isEligibleBuyGoodsTransactionType('Buy Goods')).toBe(true);
    expect(isEligibleBuyGoodsTransactionType('Buy Goods Online')).toBe(true);
  });
});

describe('Pull row primary fields', () => {
  test('uses TransID and BusinessShortCode', () => {
    const n = normalizePullTransactionRow({
      TransID: 'ABC123',
      BusinessShortCode: '654321',
      TransAmount: '100.50',
      TransTime: '20260509182900',
      TransactionType: 'Buy Goods',
    });
    expect(n.ok).toBe(true);
    expect(n.receiptNumber).toBe('ABC123');
    expect(n.businessShortCode).toBe('654321');
    expect(n.amountCents).toBe(10050);
  });
});
