import { jest } from '@jest/globals';
import fs from 'node:fs';

// ---- migration: pure classify/backfill-plan functions (no Mongo) ----
const migration = await import('../../../scripts/migrations/20261114_g5_inbox_idempotency_index.js');
const { config, deriveLegacyKey, classifyLegacyDocs, planBackfillOps, runPreflight, runMigration } = migration;
const { assertSafeTarget } = await import('../../../scripts/migrations/lib/g5MigrationGuard.js');
const { buildInboxIdempotencyKey } = await import('../../../src/services/mpesa/mpesaIngestion.service.js');

/** Minimal fake Mongo `db` supporting the cursor/count/bulkWrite/createIndex calls this migration uses. */
function fakeMigrationDb(rows) {
  const docs = rows.map((r, i) => ({ _id: r._id ?? `id${i}`, idempotencyKey: null, ...r }));
  const calls = [];
  const matches = (doc, filter) => Object.entries(filter).every(([k, v]) => {
    if (v && typeof v === 'object' && '$type' in v) {
      return v.$type === 'string' ? typeof doc[k] === 'string' : typeof doc[k] !== 'string';
    }
    if (v && typeof v === 'object' && '$not' in v) return !matches(doc, { [k]: v.$not });
    return doc[k] === v;
  });
  return {
    calls,
    _docs: docs,
    collection: () => ({
      countDocuments: async (filter) => docs.filter((d) => matches(d, filter)).length,
      find: (filter, opts) => {
        const rowsMatched = docs.filter((d) => matches(d, filter));
        const projected = opts?.projection
          ? rowsMatched.map((d) => {
            const out = { _id: d._id };
            for (const k of Object.keys(opts.projection)) out[k] = d[k];
            return out;
          })
          : rowsMatched;
        return { [Symbol.asyncIterator]: async function* () { for (const d of projected) yield d; } };
      },
      bulkWrite: async (ops) => {
        calls.push({ op: 'bulkWrite', count: ops.length });
        let modified = 0;
        for (const { updateOne } of ops) {
          const doc = docs.find((d) => d._id === updateOne.filter._id && d.idempotencyKey === updateOne.filter.idempotencyKey);
          if (doc) { Object.assign(doc, updateOne.update.$set); modified += 1; }
        }
        return { matchedCount: ops.length, modifiedCount: modified };
      },
      indexes: async () => calls.filter((c) => c.op === 'createIndex').map((c) => c.spec),
      createIndex: async (key, opts) => { calls.push({ op: 'createIndex', spec: { key, ...opts } }); },
    }),
  };
}

describe('inbox idempotency migration', () => {
  test('declares only the partial unique inbox index; no drops; no transaction index', () => {
    expect(config.drops).toEqual([]);
    expect(config.creates).toHaveLength(1);
    expect(config.creates[0]).toMatchObject({ collection: 'mpesaingestionevents', name: 'uniq_mpesa_inbox_idempotency',
      unique: true, partialFilterExpression: { idempotencyKey: { $type: 'string' } } });
  });

  test('deriveLegacyKey reuses the exact production algorithm (no second implementation)', () => {
    const doc = { sourceChannel: 'C2B_CONFIRMATION', businessShortCode: '174379', receiptNumber: 'R1', payloadDigest: 'd1' };
    expect(deriveLegacyKey(doc)).toBe(buildInboxIdempotencyKey(doc));
  });
  test('deriveLegacyKey refuses when sourceChannel or payloadDigest is missing', () => {
    expect(deriveLegacyKey({ payloadDigest: 'd1' })).toBeNull();
    expect(deriveLegacyKey({ sourceChannel: 'C2B_CONFIRMATION' })).toBeNull();
  });

  test('classifyLegacyDocs: unambiguous legacy rows are eligible for backfill', () => {
    const docs = [
      { _id: 'a', sourceChannel: 'C2B_CONFIRMATION', businessShortCode: '174379', receiptNumber: 'R1', payloadDigest: 'd1' },
      { _id: 'b', sourceChannel: 'C2B_CONFIRMATION', businessShortCode: '174379', receiptNumber: 'R2', payloadDigest: 'd2' },
    ];
    const { eligible, blockers } = classifyLegacyDocs(docs, new Set());
    expect(blockers).toHaveLength(0);
    expect(eligible.map((e) => e._id).sort()).toEqual(['a', 'b']);
    expect(eligible.find((e) => e._id === 'a').key).toBe(deriveLegacyKey(docs[0]));
  });

  test('classifyLegacyDocs: two legacy rows deriving the same key block BOTH (never merged/chosen)', () => {
    const shared = { sourceChannel: 'C2B_CONFIRMATION', businessShortCode: '174379', receiptNumber: 'R1', payloadDigest: 'd1' };
    const docs = [{ _id: 'a', ...shared }, { _id: 'b', ...shared }];
    const { eligible, blockers } = classifyLegacyDocs(docs, new Set());
    expect(eligible).toHaveLength(0);
    expect(blockers.map((b) => b._id).sort()).toEqual(['a', 'b']);
    expect(blockers.every((b) => b.reason === 'legacy_key_collision')).toBe(true);
  });

  test('classifyLegacyDocs: a derived key colliding with an EXISTING key is blocked, not overwritten', () => {
    const doc = { _id: 'a', sourceChannel: 'C2B_CONFIRMATION', businessShortCode: '174379', receiptNumber: 'R1', payloadDigest: 'd1' };
    const existingKeys = new Set([deriveLegacyKey(doc)]);
    const { eligible, blockers } = classifyLegacyDocs([doc], existingKeys);
    expect(eligible).toHaveLength(0);
    expect(blockers).toEqual([{ _id: 'a', key: existingKeys.values().next().value, reason: 'collides_with_existing_key' }]);
  });

  test('classifyLegacyDocs: malformed rows with no identity are blocked, not guessed', () => {
    const { eligible, blockers } = classifyLegacyDocs([{ _id: 'a', payloadDigest: 'd1' }], new Set());
    expect(eligible).toHaveLength(0);
    expect(blockers).toEqual([{ _id: 'a', reason: 'cannot_derive_identity' }]);
  });

  test('planBackfillOps issues only conditional updates (never unconditional)', () => {
    const ops = planBackfillOps([{ _id: 'a', key: 'obs1:x' }]);
    expect(ops).toEqual([{ updateOne: { filter: { _id: 'a', idempotencyKey: null }, update: { $set: { idempotencyKey: 'obs1:x' } } } }]);
  });

  test('runPreflight: clean data has zero blockers and is not blocked', async () => {
    const db = fakeMigrationDb([
      { _id: 'a', sourceChannel: 'C2B_CONFIRMATION', businessShortCode: '174379', receiptNumber: 'R1', payloadDigest: 'd1' },
    ]);
    const report = await runPreflight(db);
    expect(report.hardBlocked).toBe(false);
    expect(report.eligible).toHaveLength(1);
  });

  test('runPreflight: reports legacy-collision blockers (not hard-blocked); is read-only', async () => {
    const db = fakeMigrationDb([
      { _id: 'a', sourceChannel: 'C2B_CONFIRMATION', businessShortCode: '174379', receiptNumber: 'R1', payloadDigest: 'd1' },
      { _id: 'b', sourceChannel: 'C2B_CONFIRMATION', businessShortCode: '174379', receiptNumber: 'R1', payloadDigest: 'd2' },
    ]);
    const report = await runPreflight(db);
    expect(report.hardBlocked).toBe(false); // legacy collisions don't halt the whole run
    expect(report.blockers.map((b) => b.reason)).toContain('legacy_key_collision');
    expect(db.calls.filter((c) => c.op === 'bulkWrite' || c.op === 'createIndex')).toHaveLength(0);
  });

  test('runPreflight: already-keyed events colliding with each other IS hard-blocked', async () => {
    const db = fakeMigrationDb([]);
    db._docs.push({ _id: 'x', idempotencyKey: 'obs1:dup' }, { _id: 'y', idempotencyKey: 'obs1:dup' });
    const report = await runPreflight(db);
    expect(report.hardBlocked).toBe(true);
    expect(report.existingKeyDuplicates).toEqual([{ key: 'obs1:dup', count: 2 }]);
  });

  test('dry-run (default argv) backfills nothing and creates no index even when eligible rows exist', async () => {
    const db = fakeMigrationDb([
      { _id: 'a', sourceChannel: 'C2B_CONFIRMATION', businessShortCode: '174379', receiptNumber: 'R1', payloadDigest: 'd1' },
    ]);
    const res = await runMigration({ db, argv: ['node', 'migration.js'] });
    expect(res.status).toBe('dry_run');
    expect(db._docs[0].idempotencyKey).toBeNull();
    expect(db.calls).toHaveLength(0);
  });

  test('hard-blocked (existing key duplicates) --execute never backfills or creates the index', async () => {
    const db = fakeMigrationDb([]);
    db._docs.push({ _id: 'x', idempotencyKey: 'obs1:dup' }, { _id: 'y', idempotencyKey: 'obs1:dup' });
    const res = await runMigration({ db, argv: ['node', 'migration.js', '--execute'] });
    expect(res.status).toBe('blocked');
    expect(db.calls).toHaveLength(0);
  });

  test('all-ambiguous legacy data: zero backfill, but the index is still created (legacy rows stay unkeyed forever, safely excluded by the partial filter)', async () => {
    const shared = { sourceChannel: 'C2B_CONFIRMATION', businessShortCode: '174379', receiptNumber: 'R1', payloadDigest: 'd1' };
    const db = fakeMigrationDb([{ _id: 'a', ...shared }, { _id: 'b', ...shared }]);
    const res = await runMigration({ db, argv: ['node', 'migration.js', '--execute'] });
    expect(res.status).toBe('executed_verified');
    expect(res.backfilled).toBe(0);
    expect(db._docs.every((d) => d.idempotencyKey === null)).toBe(true);
    expect(db.calls.some((c) => c.op === 'createIndex')).toBe(true);
  });

  test('--execute backfills only unambiguous rows, verifies coverage, then creates the index', async () => {
    const ambiguousShared = { sourceChannel: 'C2B_CONFIRMATION', businessShortCode: '174379', receiptNumber: 'R9', payloadDigest: 'dx' };
    const db = fakeMigrationDb([
      { _id: 'a', sourceChannel: 'C2B_CONFIRMATION', businessShortCode: '174379', receiptNumber: 'R1', payloadDigest: 'd1' },
      { _id: 'b', ...ambiguousShared },
      { _id: 'c', ...ambiguousShared },
    ]);
    const res = await runMigration({ db, argv: ['node', 'migration.js', '--execute'] });
    expect(res.status).toBe('executed_verified');
    expect(res.backfilled).toBe(1);
    expect(db._docs.find((d) => d._id === 'a').idempotencyKey).toBe(deriveLegacyKey(db._docs.find((d) => d._id === 'a')));
    // Ambiguous rows are never touched (never merged or silently chosen).
    expect(db._docs.find((d) => d._id === 'b').idempotencyKey).toBeNull();
    expect(db._docs.find((d) => d._id === 'c').idempotencyKey).toBeNull();
    expect(db.calls.some((c) => c.op === 'createIndex')).toBe(true);
  });

  test('never deletes, merges, or chooses between historical events on ambiguous data', async () => {
    const shared = { sourceChannel: 'C2B_CONFIRMATION', businessShortCode: '174379', receiptNumber: 'R1', payloadDigest: 'd1' };
    const db = fakeMigrationDb([{ _id: 'a', ...shared }, { _id: 'b', ...shared }]);
    const before = JSON.stringify(db._docs);
    await runMigration({ db, argv: ['node', 'migration.js', '--execute'] });
    expect(JSON.stringify(db._docs)).toBe(before);
  });

  test('--execute refused without allowlists (shared guard, unchanged)', () => {
    for (const k of ['G5_SAFE_DB_ALLOWLIST', 'G3_SAFE_DB_ALLOWLIST', 'G5_MIGRATION_TARGET_DB', 'G3_MIGRATION_TARGET_DB']) delete process.env[k];
    expect(() => assertSafeTarget('mongodb://127.0.0.1:27017/tycoon_test_x', true)).toThrow(/Refusing --execute/);
  });
});

// ---- callers: duplicate/conflict never claim or process ----
const ingestion = {
  persistIngestionObservation: jest.fn(),
  claimIngestionEvent: jest.fn(),
  processClaimedEvent: jest.fn(),
  PERSIST_OUTCOME: { CREATED: 'created', DUPLICATE: 'duplicate', CONFLICT: 'conflict' },
};
jest.unstable_mockModule('../../../src/services/mpesa/mpesaIngestion.service.js', () => ingestion);
jest.unstable_mockModule('../../../src/config/logger.js', () => ({
  logger: { error: jest.fn(), warn: jest.fn(), info: jest.fn(), debug: jest.fn() },
}));
const { handleC2bConfirmation } = await import('../../../src/services/mpesa/darajaC2b.service.js');

describe('C2B confirmation caller', () => {
  beforeEach(() => Object.values(ingestion).forEach((f) => f.mockReset?.()));
  const body = { TransactionType: 'Pay Bill', TransID: 'RCP1', TransTime: '20261114100000', TransAmount: '100',
    BusinessShortCode: '174379', BillRefNumber: 'A1', MSISDN: '254700000000' };

  test.each(['duplicate', 'conflict'])('%s outcome: no claim, no processing', async (outcome) => {
    ingestion.persistIngestionObservation.mockResolvedValue({ event: { _id: 'e1' }, outcome });
    const r = await handleC2bConfirmation(body);
    expect(r.httpStatus).toBe(200);
    expect(ingestion.claimIngestionEvent).not.toHaveBeenCalled();
    expect(ingestion.processClaimedEvent).not.toHaveBeenCalled();
    expect(r.ingestion.duplicateEvent).toBe(outcome === 'duplicate');
    expect(r.ingestion.replayConflict).toBe(outcome === 'conflict');
  });
  test('persist failure (index not ready / lookup failure) is not acknowledged', async () => {
    ingestion.persistIngestionObservation.mockRejectedValue(Object.assign(new Error('x'), { code: 'inbox_idempotency_not_ready' }));
    const r = await handleC2bConfirmation(body);
    expect(r.httpStatus).toBe(500);
    expect(r.ack.ResultCode).toBe(1);
  });
});

describe('no financial writes in the ingestion path', () => {
  test.each([
    'src/services/mpesa/mpesaIngestion.service.js',
    'src/services/mpesa/darajaC2b.service.js',
    'src/services/mpesa/darajaPull.service.js',
  ])('%s does not import Payment, allocation, Ledger or posting', (f) => {
    const src = fs.readFileSync(f, 'utf8');
    const imports = src.split('\n').filter((l) => /^\s*(import|\}\s*from)/.test(l)).join('\n');
    expect(imports).not.toMatch(/Payment|allocation|Ledger|mpesaPosting|rent\.service/i);
  });
});
