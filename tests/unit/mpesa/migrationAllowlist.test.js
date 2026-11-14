/**
 * G5.3 acceptance — migration allowlist and import side-effect freedom.
 */
import { describe, test, expect } from '@jest/globals';
import {
  parseMongoUri,
  assertSafeTarget,
  isInvokedDirectly,
} from '../../../scripts/migrations/20261112_g53_mpesa_merchant_index.js';

describe('G5.3 migration allowlist', () => {
  test('parses db name from uri', () => {
    const p = parseMongoUri('mongodb://127.0.0.1:27017/tycoon_test');
    expect(p.dbName).toBe('tycoon_test');
  });

  test('refuses production-like database names even on dry-run', () => {
    expect(() =>
      assertSafeTarget('mongodb://127.0.0.1:27017/tycoon_production', false)
    ).toThrow(/unsafe database name/);
  });

  test('refuses --execute without allowlists', () => {
    delete process.env.G5_SAFE_DB_ALLOWLIST;
    delete process.env.G3_SAFE_DB_ALLOWLIST;
    delete process.env.G5_MIGRATION_TARGET_DB;
    delete process.env.G3_MIGRATION_TARGET_DB;
    expect(() =>
      assertSafeTarget('mongodb://127.0.0.1:27017/tycoon_test', true)
    ).toThrow(/Refusing --execute/);
  });

  test('importing the module does not invoke main', () => {
    const exitBefore = process.exitCode;
    expect(isInvokedDirectly()).toBe(false);
    expect(isInvokedDirectly('file:///tmp/migration.js', ['node', '/tmp/migration.js'])).toBe(true);
    expect(isInvokedDirectly('file:///tmp/migration.js', ['node', '/tmp/other.js'])).toBe(false);
    expect(process.exitCode).toBe(exitBefore);
  });
});
