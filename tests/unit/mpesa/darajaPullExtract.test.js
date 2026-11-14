import { describe, test, expect } from '@jest/globals';
import { extractPullRows } from '../../../src/services/mpesa/darajaPull.service.js';

describe('extractPullRows', () => {
  test('distinguishes empty bodies from unsupported responses', () => {
    expect(extractPullRows(null)).toEqual({ shape: 'empty_body', rows: [] });
    expect(extractPullRows('x')).toEqual({ shape: 'unsupported', rows: [] });
    expect(extractPullRows({ unexpected: true })).toEqual({ shape: 'unsupported', rows: [] });
  });

  test('accepts top-level arrays and identifies valid empty arrays', () => {
    const rows = [{ TransID: '1' }];
    expect(extractPullRows(rows)).toEqual({ shape: 'rows', rows });
    expect(extractPullRows([])).toEqual({ shape: 'empty_valid', rows: [] });
  });

  test('accepts Response / transactions / Transactions / data', () => {
    for (const key of ['Response', 'transactions', 'Transactions', 'data']) {
      const rows = [{ a: 1 }];
      expect(extractPullRows({ [key]: rows })).toEqual({ shape: 'rows', rows });
      expect(extractPullRows({ [key]: [] })).toEqual({ shape: 'empty_valid', rows: [] });
    }
  });
});
