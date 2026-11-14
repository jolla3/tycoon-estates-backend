/**
 * G5.3 acceptance — Pull checkpoint must not advance on unverified results.
 */
import { describe, test, expect } from '@jest/globals';
import { extractPullRows } from '../../../src/services/mpesa/darajaPull.service.js';

describe('Pull response shape classification', () => {
  test('null body is empty_body, not empty_valid', () => {
    expect(extractPullRows(null).shape).toBe('empty_body');
  });

  test('recognized empty Response array is empty_valid', () => {
    expect(extractPullRows({ Response: [] }).shape).toBe('empty_valid');
  });

  test('unrecognized object is unsupported', () => {
    expect(extractPullRows({ Message: 'ok' }).shape).toBe('unsupported');
  });

  test('row array is rows', () => {
    const r = extractPullRows({ Response: [{ TransID: '1' }] });
    expect(r.shape).toBe('rows');
    expect(r.rows).toHaveLength(1);
  });
});
