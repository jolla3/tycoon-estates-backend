import { describe, test, expect } from '@jest/globals';
import {
  normalizeC2bConfirmation,
  normalizePullTransactionRow,
  parseAmountToCents,
  parseDarajaTransTime,
} from '../../../src/services/mpesa/mpesaNormalize.js';

describe('mpesaNormalize', () => {
  test('parses TransTime YYYYMMDDHHmmss', () => {
    const d = parseDarajaTransTime('20260509182900');
    expect(d).toBeInstanceOf(Date);
    expect(d.getUTCFullYear()).toBe(2026);
    expect(d.getUTCMonth()).toBe(4);
    expect(d.getUTCDate()).toBe(9);
  });

  test('parses amount to cents', () => {
    expect(parseAmountToCents('60.00')).toBe(6000);
    expect(parseAmountToCents(60)).toBe(6000);
    expect(parseAmountToCents('bad')).toBeNull();
  });

  test('Buy Goods confirmation accepts missing BillRefNumber', () => {
    const n = normalizeC2bConfirmation({
      TransactionType: 'Pay Bill',
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
    expect(n.validationErrors).toEqual([]);
  });

  test('rejects missing receipt', () => {
    const n = normalizeC2bConfirmation({
      TransAmount: '10.00',
      BusinessShortCode: '123456',
      TransTime: '20260509182900',
    });
    expect(n.ok).toBe(false);
    expect(n.validationErrors).toContain('missing_receipt');
  });

  test('pull row aliases', () => {
    const n = normalizePullTransactionRow({
      TransactionID: 'ABC123',
      ShortCode: '654321',
      Amount: '100.50',
      TransactionDate: '20260509182900',
    });
    expect(n.ok).toBe(true);
    expect(n.receiptNumber).toBe('ABC123');
    expect(n.businessShortCode).toBe('654321');
    expect(n.amountCents).toBe(10050);
  });

  test('stable digest differs when amount changes', () => {
    const a = normalizeC2bConfirmation({
      TransID: 'R1',
      TransTime: '20260509182900',
      TransAmount: '10.00',
      BusinessShortCode: '1',
    });
    const b = normalizeC2bConfirmation({
      TransID: 'R1',
      TransTime: '20260509182900',
      TransAmount: '11.00',
      BusinessShortCode: '1',
    });
    expect(a.payloadDigest).not.toBe(b.payloadDigest);
  });
});
