/**
 * G5.3 — stale workers must not report a successful transition.
 */
import { describe, test, expect } from '@jest/globals';
import { leaseLostError } from '../../../src/services/mpesa/mpesaIngestion.service.js';
import { checkpointAdvanceSucceeded } from '../../../src/services/mpesa/checkpointFence.js';

describe('lease and checkpoint fence', () => {
  test('lease loss is a distinct error', () => {
    const err = leaseLostError();
    expect(err.message).toBe('lease_lost_before_complete');
    expect(err.code).toBe('lease_lost_before_complete');
  });

  test('missing checkpoint update is not success', () => {
    expect(checkpointAdvanceSucceeded(null)).toBe(false);
    expect(checkpointAdvanceSucceeded(undefined)).toBe(false);
    expect(checkpointAdvanceSucceeded({ _id: 'cp' })).toBe(true);
  });
});
