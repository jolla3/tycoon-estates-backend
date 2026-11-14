// G5.3 — durable inbox idempotency, conflicting replay, races, canonical fail-closed.
// MpesaIngestionEvent is replaced by an in-memory fake that enforces the partial unique index
// on idempotencyKey (and yields to the event loop so concurrent inserts really race).
import { jest } from '@jest/globals';

const rows = [];
let idSeq = 0;
let failFindOne = false;
const txnCalls = jest.fn();
const dup = () => Object.assign(new Error('E11000 duplicate key'), { code: 11000 });
const q = (v) => ({ session: () => v, then: (a, b) => Promise.resolve(v).then(a, b) });

const FakeEvent = {
  async create(docs) {
    await new Promise((r) => setImmediate(r));
    const out = [];
    for (const d of docs) {
      if (typeof d.idempotencyKey === 'string' && rows.some((r) => r.idempotencyKey === d.idempotencyKey)) throw dup();
      const row = { _id: `e${++idSeq}`, replayCount: 0, conflictCount: 0, conflictDigests: [],
        processingLeaseToken: null, processingLeaseExpiresAt: null, firstConflictAt: null, ...d };
      rows.push(row); out.push(row);
    }
    return out;
  },
  findOne(f) {
    if (failFindOne) return q(Promise.reject(new Error('mongo down')));
    return q(rows.find((r) => r.idempotencyKey === f.idempotencyKey) || null);
  },
  async updateOne(f, u) {
    const r = rows.find((x) => x._id === f._id);
    if (r && u.$inc) for (const [k, v] of Object.entries(u.$inc)) r[k] = (r[k] || 0) + v;
    if (r && u.$set) Object.assign(r, u.$set);
    return { matchedCount: r ? 1 : 0 };
  },
  async findOneAndUpdate(f, u) {
    const r = rows.find((x) => x._id === f._id);
    if (!r) return null;
    if (Array.isArray(u)) { // conflict pipeline: emulate the documented stage
      const s = u[0].$set;
      const now = s.lastConflictAt;
      const digest = s.conflictDigests.$slice[0].$cond[2].$concatArrays[1][0];
      Object.assign(r, { state: s.state, quarantineCategory: s.quarantineCategory, reasonCode: s.reasonCode,
        processingLeaseToken: null, processingLeaseExpiresAt: null, conflictCount: r.conflictCount + 1,
        firstConflictAt: r.firstConflictAt || now, lastConflictAt: now });
      if (!r.conflictDigests.includes(digest)) r.conflictDigests = [...r.conflictDigests, digest].slice(0, s.conflictDigests.$slice[1]);
      return r;
    }
    if (u.$set) Object.assign(r, u.$set);
    return r;
  },
};

jest.unstable_mockModule('../../../src/models/MpesaIngestionEvent.js', () => ({ MpesaIngestionEvent: FakeEvent }));
jest.unstable_mockModule('../../../src/models/MpesaTransaction.js', () => ({
  MpesaTransaction: { findOne: txnCalls, create: txnCalls, updateOne: txnCalls, findOneAndUpdate: txnCalls },
}));
jest.unstable_mockModule('../../../src/models/MpesaMerchantProfile.js', () => ({
  MpesaMerchantProfile: { find: () => q([{ _id: 'p1', clientId: 'c1', operationalState: 'ACTIVE' }]) },
}));
jest.unstable_mockModule('../../../src/config/logger.js', () => ({
  logger: { error: jest.fn(), warn: jest.fn(), info: jest.fn(), debug: jest.fn() },
}));

const svc = await import('../../../src/services/mpesa/mpesaIngestion.service.js');
const { INGESTION_SOURCE, INGESTION_STATE } = await import('../../../src/services/mpesa/daraja.constants.js');
const { INBOX_IDEMPOTENCY_INDEX, indexMatches, isCanonicalReceiptIdentityReady } =
  await import('../../../src/utils/mpesaIndexReadiness.js');

const ready = () => true;
const obs = (o = {}) => ({ sourceChannel: INGESTION_SOURCE.C2B_CONFIRMATION, businessShortCode: '174379',
  receiptNumber: 'RCP1', payloadDigest: 'd1', ok: true, amountCents: 100, ...o });

beforeEach(() => { rows.length = 0; idSeq = 0; failFindOne = false; txnCalls.mockClear(); });

describe('idempotency key', () => {
  test('same observation => same key regardless of digest; channel differs => different key', () => {
    const a = svc.buildInboxIdempotencyKey(obs());
    expect(a).toMatch(/^obs1:[0-9a-f]{64}$/);
    expect(svc.buildInboxIdempotencyKey(obs({ payloadDigest: 'other' }))).toBe(a);
    expect(svc.buildInboxIdempotencyKey(obs({ sourceChannel: INGESTION_SOURCE.PULL_QUERY }))).not.toBe(a);
  });
  test('malformed observation uses bounded mal1 key', () => {
    expect(svc.buildInboxIdempotencyKey(obs({ receiptNumber: null }))).toMatch(/^mal1:/);
  });
});

describe('persistIngestionObservation', () => {
  test('refuses when idempotency index not verified', async () => {
    await expect(svc.persistIngestionObservation(obs(), { readyCheck: () => false }))
      .rejects.toMatchObject({ code: 'inbox_idempotency_not_ready' });
    expect(rows).toHaveLength(0);
  });

  test('identical repeat returns existing event, counts replay, creates no second row', async () => {
    const a = await svc.persistIngestionObservation(obs(), { readyCheck: ready });
    const b = await svc.persistIngestionObservation(obs(), { readyCheck: ready });
    expect(a.outcome).toBe('created');
    expect(b.outcome).toBe('duplicate');
    expect(b.event._id).toBe(a.event._id);
    expect(rows).toHaveLength(1);
    expect(rows[0].replayCount).toBe(1);
  });

  test('conflicting payload quarantines, fences lease, keeps original data', async () => {
    const a = await svc.persistIngestionObservation(obs(), { readyCheck: ready });
    rows[0].state = INGESTION_STATE.PROCESSING; rows[0].processingLeaseToken = 'tok';
    const before = JSON.stringify(rows[0].payloadRedacted);
    const c = await svc.persistIngestionObservation(obs({ payloadDigest: 'd2', amountCents: 999999 }), { readyCheck: ready });
    expect(c.outcome).toBe('conflict');
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ state: 'QUARANTINED', quarantineCategory: 'replay_conflict',
      processingLeaseToken: null, conflictCount: 1, payloadDigest: 'd1' });
    expect(JSON.stringify(rows[0].payloadRedacted)).toBe(before);
    expect(rows[0].conflictDigests).toEqual(['d2']);
    expect(c.event._id).toBe(a.event._id);
  });

  test('conflict digests are capped at 5', async () => {
    await svc.persistIngestionObservation(obs(), { readyCheck: ready });
    for (let i = 0; i < 8; i++) await svc.persistIngestionObservation(obs({ payloadDigest: `x${i}` }), { readyCheck: ready });
    expect(rows[0].conflictDigests).toHaveLength(5);
    expect(rows[0].conflictCount).toBe(8);
  });

  test('concurrent identical deliveries: exactly one row, one created outcome', async () => {
    const res = await Promise.all(Array.from({ length: 10 }, () => svc.persistIngestionObservation(obs(), { readyCheck: ready })));
    expect(rows).toHaveLength(1);
    expect(res.filter((r) => r.outcome === 'created')).toHaveLength(1);
    expect(res.filter((r) => r.outcome === 'duplicate')).toHaveLength(9);
  });

  test('concurrent conflicting deliveries: one row, no overwrite', async () => {
    const res = await Promise.all(['d1', 'd2', 'd3', 'd4'].map((d) => svc.persistIngestionObservation(obs({ payloadDigest: d }), { readyCheck: ready })));
    expect(rows).toHaveLength(1);
    expect(res.filter((r) => r.outcome === 'created')).toHaveLength(1);
    expect(rows[0].payloadRedacted.receiptNumber).toBe('RCP1');
  });

  test('E11000 then lookup failure throws retryable error, never a successful duplicate', async () => {
    await svc.persistIngestionObservation(obs(), { readyCheck: ready });
    failFindOne = true;
    await expect(svc.persistIngestionObservation(obs(), { readyCheck: ready })).rejects.toThrow('mongo down');
    failFindOne = false;
    // E11000 but row not found on re-read
    const orig = FakeEvent.findOne; FakeEvent.findOne = () => q(null);
    await expect(svc.persistIngestionObservation(obs(), { readyCheck: ready }))
      .rejects.toMatchObject({ code: 'inbox_duplicate_lookup_failed' });
    FakeEvent.findOne = orig;
  });

  test('duplicate-key inside a transaction propagates (never swallowed)', async () => {
    await svc.persistIngestionObservation(obs(), { readyCheck: ready });
    await expect(svc.persistIngestionObservation(obs(), { readyCheck: ready, session: { inTransaction: () => true } }))
      .rejects.toMatchObject({ code: 11000 });
  });

  test('C2B and Pull observations of the same receipt are two separate events', async () => {
    const c2b = await svc.persistIngestionObservation(obs(), { readyCheck: ready });
    const pull = await svc.persistIngestionObservation(obs({ sourceChannel: INGESTION_SOURCE.PULL_QUERY, payloadDigest: 'p1' }), { readyCheck: ready });
    expect(c2b.outcome).toBe('created');
    expect(pull.outcome).toBe('created');
    expect(rows).toHaveLength(2);
    expect(rows[0].idempotencyKey).not.toBe(rows[1].idempotencyKey);
  });
});

describe('canonical fail-closed', () => {
  test('canonical identity is never ready by default', () => {
    expect(isCanonicalReceiptIdentityReady()).toBe(false);
  });

  test('processClaimedEvent quarantines without any MpesaTransaction or financial write', async () => {
    const { event } = await svc.persistIngestionObservation(obs(), { readyCheck: ready });
    const claim = await svc.claimIngestionEvent(event._id);
    const res = await svc.processClaimedEvent(claim.event, claim.leaseToken, obs(), { session: {} });
    expect(res).toMatchObject({ quarantined: true, reason: 'canonical_identity_unverified', transaction: null });
    expect(rows[0]).toMatchObject({ state: 'QUARANTINED', quarantineCategory: 'canonical_identity_unverified',
      normalizedTransactionId: null });
    expect(txnCalls).not.toHaveBeenCalled();
  });
});

describe('index spec', () => {
  test('partial unique spec only matches exact partial filter', () => {
    const base = { name: INBOX_IDEMPOTENCY_INDEX.name, key: { idempotencyKey: 1 }, unique: true };
    expect(indexMatches([{ ...base, partialFilterExpression: INBOX_IDEMPOTENCY_INDEX.partialFilterExpression }], INBOX_IDEMPOTENCY_INDEX)).toBe(true);
    expect(indexMatches([base], INBOX_IDEMPOTENCY_INDEX)).toBe(false);
    expect(indexMatches([{ ...base, unique: false, partialFilterExpression: INBOX_IDEMPOTENCY_INDEX.partialFilterExpression }], INBOX_IDEMPOTENCY_INDEX)).toBe(false);
  });
});
