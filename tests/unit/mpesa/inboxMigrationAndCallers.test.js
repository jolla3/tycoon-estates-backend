import { jest } from '@jest/globals';
import fs from 'node:fs';

// ---- migration preflight / dry-run safety (fake db, no connection) ----
const { config } = await import('../../../scripts/migrations/20261114_g5_inbox_idempotency_index.js');
const { assertSafeTarget } = await import('../../../scripts/migrations/lib/g5MigrationGuard.js');

function fakeDb({ keyed = [], legacy = [] }) {
  const calls = [];
  return {
    calls,
    collection: (name) => ({
      aggregate: (pipe) => ({
        toArray: async () => {
          calls.push({ name, op: 'aggregate' });
          const m = pipe[0].$match;
          const rows = m.idempotencyKey?.$type === 'string' ? keyed : legacy;
          const counts = new Map();
          for (const r of rows) counts.set(JSON.stringify(r), (counts.get(JSON.stringify(r)) || 0) + 1);
          return [...counts].filter(([, n]) => n > 1).map(([k, n]) => ({ _id: JSON.parse(k), n }));
        },
      }),
      createIndex: async () => { calls.push({ name, op: 'createIndex' }); },
      dropIndex: async () => { calls.push({ name, op: 'dropIndex' }); },
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
  test('preflight is read-only and reports duplicate keys and legacy collisions', async () => {
    const db = fakeDb({ keyed: ['k1', 'k1', 'k2'], legacy: [{ r: 'A' }, { r: 'A' }] });
    const res = await config.preflight(db);
    expect(res.find((c) => c.check === 'dup_inbox_idempotency_key').samples).toHaveLength(1);
    expect(res.find((c) => c.check === 'legacy_inbox_observation_collisions').samples).toHaveLength(1);
    expect(db.calls.every((c) => c.op === 'aggregate')).toBe(true);
  });
  test('clean data yields no blockers', async () => {
    const res = await config.preflight(fakeDb({ keyed: ['a', 'b'], legacy: [{ r: 'A' }, { r: 'B' }] }));
    expect(res.every((c) => c.samples.length === 0)).toBe(true);
  });
  test('--execute refused without allowlists; importing does not run the migration', () => {
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
