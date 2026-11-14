/**
 * G5.3 — pure logic tests for multi-merchant event scope and conflict rules.
 * No MongoDB required.
 */
import { describe, test, expect } from '@jest/globals';
import {
  normalizeC2bConfirmation,
  stablePayloadDigest,
} from '../../../src/services/mpesa/mpesaNormalize.js';

describe('ingestion scope (pure)', () => {
  test('identical bodies for different shortcodes produce different digests when shortcode is in body', () => {
    const a = normalizeC2bConfirmation({
      TransactionType: 'Buy Goods',
      TransID: 'R1',
      TransTime: '20260509182900',
      TransAmount: '10.00',
      BusinessShortCode: '111',
      BillRefNumber: '',
    });
    const b = normalizeC2bConfirmation({
      TransactionType: 'Buy Goods',
      TransID: 'R1',
      TransTime: '20260509182900',
      TransAmount: '10.00',
      BusinessShortCode: '222',
      BillRefNumber: '',
    });
    expect(a.payloadDigest).not.toBe(b.payloadDigest);
    expect(a.businessShortCode).toBe('111');
    expect(b.businessShortCode).toBe('222');
  });

  test('stable digest is deterministic for the same payload', () => {
    const payload = { TransID: 'X', TransAmount: '1.00', BusinessShortCode: '9' };
    expect(stablePayloadDigest(payload)).toBe(stablePayloadDigest(payload));
  });

  test('amount change changes digest', () => {
    const a = normalizeC2bConfirmation({
      TransactionType: 'Buy Goods',
      TransID: 'R1',
      TransTime: '20260509182900',
      TransAmount: '10.00',
      BusinessShortCode: '1',
      BillRefNumber: '',
    });
    const b = normalizeC2bConfirmation({
      TransactionType: 'Buy Goods',
      TransID: 'R1',
      TransTime: '20260509182900',
      TransAmount: '11.00',
      BusinessShortCode: '1',
      BillRefNumber: '',
    });
    expect(a.payloadDigest).not.toBe(b.payloadDigest);
  });
});
