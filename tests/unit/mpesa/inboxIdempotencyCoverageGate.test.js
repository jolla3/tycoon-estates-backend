// G5.3 — the inboxIdempotency readiness gate must prove COMPLETE legacy backfill coverage, not
// merely that the partial unique index object exists. An index created by hand, or left over from
// an interrupted/partial migration run, must never be reported ready while derivable-but-unkeyed
// rows remain.
import { jest } from '@jest/globals';

function fakeIndexes({ present }) {
  if (!present) return [];
  return [{
    name: 'uniq_mpesa_inbox_idempotency', key: { idempotencyKey: 1 }, unique: true,
    partialFilterExpression: { idempotencyKey: { $type: 'string' } },
  }];
}

function mockMongoose({ indexPresent, remainingUnkeyed = 0, countError = null }) {
  const collections = {};
  const base = (name) => ({
    indexes: async () => (name === 'mpesaingestionevents' ? fakeIndexes({ present: indexPresent }) : []),
    countDocuments: async () => {
      if (countError) throw countError;
      return remainingUnkeyed;
    },
  });
  return {
    connection: {
      db: { collection: (name) => collections[name] || (collections[name] = base(name)) },
    },
  };
}

async function loadReadinessWithMongoose(mongooseInstance) {
  jest.resetModules();
  jest.unstable_mockModule('mongoose', () => ({ default: mongooseInstance }));
  jest.unstable_mockModule('../../../src/config/logger.js', () => ({
    logger: { debug: jest.fn(), error: jest.fn(), warn: jest.fn(), info: jest.fn() },
  }));
  return import('../../../src/utils/mpesaIndexReadiness.js');
}

describe('inboxIdempotency readiness requires complete backfill coverage', () => {
  test('index present + zero derivable-unkeyed rows => gate true', async () => {
    const { inspectMpesaIndexes } = await loadReadinessWithMongoose(
      mockMongoose({ indexPresent: true, remainingUnkeyed: 0 })
    );
    const report = await inspectMpesaIndexes();
    expect(report.gates.inboxIdempotency).toBe(true);
  });

  test('index present but derivable-unkeyed rows remain (partial backfill) => gate stays false', async () => {
    const { inspectMpesaIndexes } = await loadReadinessWithMongoose(
      mockMongoose({ indexPresent: true, remainingUnkeyed: 3 })
    );
    const report = await inspectMpesaIndexes();
    expect(report.gates.inboxIdempotency).toBe(false);
  });

  test('index absent => gate false regardless of coverage', async () => {
    const { inspectMpesaIndexes } = await loadReadinessWithMongoose(
      mockMongoose({ indexPresent: false, remainingUnkeyed: 0 })
    );
    const report = await inspectMpesaIndexes();
    expect(report.gates.inboxIdempotency).toBe(false);
  });

  test('coverage check failure fails closed, never assumes coverage', async () => {
    const { inspectMpesaIndexes } = await loadReadinessWithMongoose(
      mockMongoose({ indexPresent: true, countError: new Error('mongo down') })
    );
    const report = await inspectMpesaIndexes();
    expect(report.gates.inboxIdempotency).toBe(false);
  });

  test('isInboxIdempotencyReady reflects the same complete-coverage requirement', async () => {
    const { isInboxIdempotencyReady } = await loadReadinessWithMongoose(
      mockMongoose({ indexPresent: true, remainingUnkeyed: 1 })
    );
    expect(await isInboxIdempotencyReady()).toBe(false);
  });
});
