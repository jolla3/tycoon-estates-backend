/**
 * G5.3 — readiness collection name and required index definitions.
 */
import { describe, test, expect } from '@jest/globals';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import {
  MPESA_COLLECTIONS,
  REQUIRED_OPERATIONAL_INDEXES,
  indexMatches,
} from '../../../src/utils/mpesaIndexReadiness.js';

const here = dirname(fileURLToPath(import.meta.url));

describe('M-PESA index readiness contract', () => {
  test('transaction collection is mpesatransactions', () => {
    expect(MPESA_COLLECTIONS.transactions).toBe('mpesatransactions');
    const src = readFileSync(join(here, '../../../src/utils/mpesaIndexReadiness.js'), 'utf8');
    expect(src).not.toContain('mpesatransed');
    expect(src).toContain('mpesatransactions');
  });

  test('operational indexes are non-unique and exact', () => {
    expect(REQUIRED_OPERATIONAL_INDEXES.length).toBeGreaterThan(0);
    for (const spec of REQUIRED_OPERATIONAL_INDEXES) {
      expect(spec.unique).toBe(false);
      expect(spec.name.startsWith('uniq_')).toBe(false);
    }
    const inbox = REQUIRED_OPERATIONAL_INDEXES.filter((s) => s.gate === 'durableInbox');
    expect(inbox.map((s) => s.name)).toEqual([
      'idx_mpesa_inbox_processing',
      'idx_mpesa_inbox_merchant_channel',
      'idx_mpesa_inbox_digest_diag',
    ]);
    const fake = [{
      name: 'idx_mpesa_inbox_processing',
      key: { state: 1, nextAttemptAt: 1, receivedAt: 1 },
      unique: false,
    }];
    expect(indexMatches(fake, inbox[0])).toBe(true);
    expect(indexMatches([{ key: { state: 1 }, unique: false, name: 'idx_mpesa_inbox_processing' }], inbox[0])).toBe(false);
  });

  test('ensureIndexes does not createIndexes on M-PESA models', () => {
    const src = readFileSync(join(here, '../../../src/utils/ensureIndexes.js'), 'utf8');
    expect(src).toContain('provisionMpesaOperationalIndexes');
    expect(src).not.toContain("mongoose.models['MpesaTransaction'].createIndexes");
    expect(src).toContain('Do NOT call model.createIndexes()');
  });
});
