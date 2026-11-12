import { describe, test, expect } from '@jest/globals';
import { extractPullRows } from '../../../src/services/mpesa/darajaPull.service.js';

describe('extractPullRows', () => {
  test('returns empty for null/non-object', () => {
    expect(extractPullRows(null)).toEqual([]);
    expect(extractPullRows('x')).toEqual([]);
  });
  test('accepts top-level array', () => {
    expect(extractPullRows([{ TransID: '1' }])).toHaveLength(1);
  });
  test('accepts Response / transactions / Transactions / data', () => {
    expect(extractPullRows({ Response: [{ a: 1 }] })).toHaveLength(1);
    expect(extractPullRows({ transactions: [{ a: 1 }] })).toHaveLength(1);
    expect(extractPullRows({ Transactions: [{ a: 1 }] })).toHaveLength(1);
    expect(extractPullRows({ data: [{ a: 1 }] })).toHaveLength(1);
  });
});
