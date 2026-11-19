import { describe, test, expect } from '@jest/globals';
import {
  generateCollectionReference, normalizeCollectionReference, formatCollectionReference,
  REFERENCE_LENGTH, PROVIDER_BILLREF_MAX_LENGTH, REFERENCE_ALPHABET,
} from '../../../src/utils/mpesaCollectionReference.js';

describe('PayBill collection reference', () => {
  test('is short, non-sensitive, inside the provider length limit and not a Mongo id', () => {
    const ref = generateCollectionReference();
    expect(ref).toHaveLength(REFERENCE_LENGTH);
    expect(ref.length).toBeLessThanOrEqual(PROVIDER_BILLREF_MAX_LENGTH);
    expect(ref).toMatch(/^T[0-9A-HJKMNP-TV-Z]{9}$/);
    expect(ref).not.toMatch(/^[a-f0-9]{24}$/i);
  });

  test('generated references always round-trip through normalization', () => {
    for (let i = 0; i < 500; i += 1) {
      const ref = generateCollectionReference();
      expect(normalizeCollectionReference(ref)).toEqual({ status: 'ok', reference: ref });
    }
  });

  test('collision-resistant over a large sample', () => {
    const seen = new Set();
    for (let i = 0; i < 20000; i += 1) seen.add(generateCollectionReference());
    expect(seen.size).toBe(20000);
  });

  test('tolerates case, spaces, hyphens and look-alike characters', () => {
    const ref = generateCollectionReference();
    const display = formatCollectionReference(ref).toLowerCase().replace(/-/g, ' - ');
    expect(normalizeCollectionReference(`  ${display}  `)).toEqual({ status: 'ok', reference: ref });
  });

  test.each([
    [null, 'missing'], [undefined, 'missing'], ['', 'missing'], ['   ', 'missing'],
    ['HOUSE-1', 'malformed'], ['T12345', 'malformed'], ['x'.repeat(21), 'malformed'],
    ['Sample Transaction', 'malformed'], ['T0000000000', 'malformed'],
  ])('%p is %s and never matches fuzzily', (raw, status) => {
    expect(normalizeCollectionReference(raw)).toEqual({ status, reference: null });
  });

  test('a single mistyped character is rejected by the check character', () => {
    const ref = generateCollectionReference();
    const idx = 3;
    const swapped = REFERENCE_ALPHABET[(REFERENCE_ALPHABET.indexOf(ref[idx]) + 1) % 32];
    const bad = `${ref.slice(0, idx)}${swapped}${ref.slice(idx + 1)}`;
    expect(normalizeCollectionReference(bad).status).toBe('malformed');
  });
});
