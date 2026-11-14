/**
 * G5.3 acceptance — Pull checkpoint must not advance on unverified results.
 */
import { describe, test, expect } from '@jest/globals';
import { extractPullRows } from '../../../src/services/mpesa/darajaPull.service.js';

describe('Pull response shape classification', () => {
  test('null body is empty_body, not empty_valid', () => {
    expect(extractPullRows(null).shape).toBe('empty_body');
  });

  test('empty Response array without an explicit provider status is unsupported', () => {
    expect(extractPullRows({ Response: [] })).toEqual({
      shape: 'unsupported',
      rows: [],
    });
  });

  test('documented ResponseCode 1001 identifies an empty result window', () => {
    expect(extractPullRows({ ResponseCode: '1001', Response: [] })).toEqual({
      shape: 'empty_valid',
      rows: [],
    });
  });

  test('ResponseCode 1000 with an empty Response array is not proof of an empty window', () => {
    expect(extractPullRows({ ResponseCode: '1000', Response: [] })).toEqual({
      shape: 'unsupported',
      rows: [],
    });
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
