// G5.3 — recovery of orphaned RECEIVED, FAILED_RETRYABLE and expired PROCESSING events.
// Recovery must reuse claimIngestionEvent/processClaimedEvent unmodified (lease fencing, canonical
// fail-closed gate) and never bypass any gate. Fake MpesaIngestionEvent model with real CAS semantics.
import { jest } from '@jest/globals';

let idSeq = 0;
const rows = [];
const txnCalls = jest.fn();

const mk = (o) => ({
  _id: `e${++idSeq}`, provider: 'SAFARICOM', state: 'RECEIVED', attempts: 0,
  processingLeaseToken: null, processingLeaseExpiresAt: null, processingStartedAt: null,
  nextAttemptAt: null, createdAt: new Date(Date.now() - 60_000), receivedAt: new Date(Date.now() - 60_000),
  payloadRedacted: { amountCents: 100 }, ...o,
});

// A single, correct generic matcher used by every fake query method below (find, findOneAndUpdate,
// updateOne) so filter semantics ($or, $lte) are evaluated consistently instead of ad hoc per call.
function matchesFilter(doc, filter) {
  return Object.entries(filter).every(([k, v]) => {
    if (k === '$or') return v.some((clause) => matchesFilter(doc, clause));
    if (v && typeof v === 'object' && !(v instanceof Date)) {
      if ('$lte' in v) return doc[k] != null && doc[k] <= v.$lte;
      if ('$or' in v) return v.$or.some((vv) => matchesFilter(doc, { [k]: vv }));
    }
    return doc[k] === v;
  });
}

const FakeEvent = {
  // find() itself must be synchronous-returning-chainable (not a Promise) to match Mongoose's
  // Query API (`.find().sort().limit()`), matching the production service's usage.
  find(filter) {
    const out = rows.filter((doc) => matchesFilter(doc, filter));
    return { sort: () => ({ limit: (n) => out.slice(0, n) }) };
  },
  async findOneAndUpdate(f, u, opts) {
    const r = rows.find((x) => matchesFilter(x, f));
    if (!r) return null;
    if (u.$set) Object.assign(r, u.$set);
    if (u.$inc) for (const [k, v] of Object.entries(u.$inc)) r[k] = (r[k] || 0) + v;
    return opts?.new ? r : r;
  },
  async updateOne(f, u) {
    const r = rows.find((x) => matchesFilter(x, f));
    if (r && u.$set) Object.assign(r, u.$set);
    return { matchedCount: r ? 1 : 0 };
  },
  async findOne(f) { return rows.find((x) => matchesFilter(x, f)) || null; },
  async create(docs) { const out = docs.map((d) => mk(d)); rows.push(...out); return out; },
};

jest.unstable_mockModule('../../../src/models/MpesaIngestionEvent.js', () => ({ MpesaIngestionEvent: FakeEvent }));
jest.unstable_mockModule('../../../src/models/MpesaTransaction.js', () => ({
  MpesaTransaction: { findOne: txnCalls, create: txnCalls, updateOne: txnCalls, findOneAndUpdate: txnCalls },
}));
jest.unstable_mockModule('../../../src/models/MpesaMerchantProfile.js', () => ({
  // resolveMerchantProfilesByShortCode calls `.find({...}).session(session || null)` — the
  // returned value must support `.session()`, not just be a plain array/Promise.
  MpesaMerchantProfile: {
    find: () => ({
      session: async () => [{ _id: 'p1', clientId: 'c1', operationalState: 'ACTIVE' }],
    }),
  },
}));
jest.unstable_mockModule('../../../src/config/logger.js', () => ({
  logger: { error: jest.fn(), warn: jest.fn(), info: jest.fn(), debug: jest.fn() },
}));
// processClaimedEvent starts a real mongoose session/transaction when called without one (the
// production recovery path has a real Mongo connection). No live DB exists in this unit test, so
// the session is faked to just run the callback inline — this does not change the production code
// path, only what backs `mongoose.startSession()` in this isolated test.
jest.unstable_mockModule('mongoose', () => ({
  default: {
    startSession: async () => ({
      withTransaction: async (fn) => fn(),
      endSession: async () => {},
    }),
  },
}));

const svc = await import('../../../src/services/mpesa/mpesaIngestion.service.js');

beforeEach(() => { rows.length = 0; idSeq = 0; txnCalls.mockClear(); });

describe('reclaimExpiredProcessingEvents', () => {
  test('recovers an orphaned RECEIVED event: claims it and quarantines on canonical fail-closed (no financial write)', async () => {
    rows.push(mk({
      state: 'RECEIVED', sourceChannel: 'C2B_CONFIRMATION', businessShortCode: '174379',
      receiptNumber: 'R1', payloadDigest: 'd1', idempotencyKey: 'obs1:x1',
    }));
    const res = await svc.reclaimExpiredProcessingEvents({ limit: 10 });
    expect(res).toEqual([{ eventId: rows[0]._id, outcome: 'processed', quarantined: true }]);
    expect(rows[0].state).toBe('QUARANTINED');
    expect(rows[0].quarantineCategory).toBe('canonical_identity_unverified');
    expect(txnCalls).not.toHaveBeenCalled();
  });

  test('recovers FAILED_RETRYABLE only once nextAttemptAt has elapsed', async () => {
    rows.push(mk({
      state: 'FAILED_RETRYABLE', sourceChannel: 'C2B_CONFIRMATION', businessShortCode: '174379',
      receiptNumber: 'R2', payloadDigest: 'd2', idempotencyKey: 'obs1:x2',
      nextAttemptAt: new Date(Date.now() + 60_000), // still in the future: not yet due
    }));
    expect(await svc.reclaimExpiredProcessingEvents({ limit: 10 })).toEqual([]);
    rows[0].nextAttemptAt = new Date(Date.now() - 1000); // now due
    const res = await svc.reclaimExpiredProcessingEvents({ limit: 10 });
    expect(res[0].outcome).toBe('processed');
  });

  test('recovers an expired PROCESSING lease', async () => {
    rows.push(mk({
      state: 'PROCESSING', processingLeaseToken: 'stale', processingLeaseExpiresAt: new Date(Date.now() - 1000),
      sourceChannel: 'C2B_CONFIRMATION', businessShortCode: '174379', receiptNumber: 'R3',
      payloadDigest: 'd3', idempotencyKey: 'obs1:x3',
    }));
    const res = await svc.reclaimExpiredProcessingEvents({ limit: 10 });
    expect(res[0].outcome).toBe('processed');
  });

  test('does not recover a fresh RECEIVED event (below the minimum-age guard)', async () => {
    rows.push(mk({
      state: 'RECEIVED', createdAt: new Date(), receivedAt: new Date(),
      sourceChannel: 'C2B_CONFIRMATION', businessShortCode: '174379', receiptNumber: 'R4',
      payloadDigest: 'd4', idempotencyKey: 'obs1:x4',
    }));
    expect(await svc.reclaimExpiredProcessingEvents({ limit: 10 })).toEqual([]);
  });

  test('never retries a QUARANTINED (conflict or terminal) event', async () => {
    rows.push(mk({ state: 'QUARANTINED', quarantineCategory: 'replay_conflict', receiptNumber: 'R5' }));
    expect(await svc.reclaimExpiredProcessingEvents({ limit: 10 })).toEqual([]);
  });

  test('quarantines with an explicit reason when safe data cannot be reconstructed', async () => {
    rows.push(mk({ state: 'RECEIVED', sourceChannel: null, payloadDigest: null, receiptNumber: 'R6' }));
    const res = await svc.reclaimExpiredProcessingEvents({ limit: 10 });
    expect(res[0].outcome).toBe('quarantined_insufficient_data');
    expect(rows[0].state).toBe('QUARANTINED');
    expect(rows[0].quarantineCategory).toBe('recovery_insufficient_data');
  });

  test('exceeding MAX_RECOVERY_ATTEMPTS marks the event FAILED_TERMINAL instead of looping forever', async () => {
    rows.push(mk({ state: 'FAILED_RETRYABLE', nextAttemptAt: new Date(Date.now() - 1000), attempts: 8, receiptNumber: 'R7' }));
    const res = await svc.reclaimExpiredProcessingEvents({ limit: 10 });
    expect(res[0].outcome).toBe('terminal_max_attempts');
    expect(rows[0].state).toBe('FAILED_TERMINAL');
  });

  test('concurrent workers cannot both claim the same event (only one processes it)', async () => {
    rows.push(mk({
      state: 'RECEIVED', sourceChannel: 'C2B_CONFIRMATION', businessShortCode: '174379',
      receiptNumber: 'R8', payloadDigest: 'd8', idempotencyKey: 'obs1:x8',
    }));
    const [a, b] = await Promise.all([
      svc.reclaimExpiredProcessingEvents({ limit: 10 }),
      svc.reclaimExpiredProcessingEvents({ limit: 10 }),
    ]);
    const processed = [...a, ...b].filter((r) => r.outcome === 'processed');
    const notClaimed = [...a, ...b].filter((r) => r.outcome === 'not_claimed');
    expect(processed).toHaveLength(1);
    expect(notClaimed).toHaveLength(1);
  });
});

describe('nextRetryBackoffMs', () => {
  test('grows with attempts and is capped', () => {
    expect(svc.nextRetryBackoffMs(1)).toBeLessThan(svc.nextRetryBackoffMs(2));
    expect(svc.nextRetryBackoffMs(2)).toBeLessThan(svc.nextRetryBackoffMs(3));
    expect(svc.nextRetryBackoffMs(20)).toBeLessThanOrEqual(30 * 60 * 1000);
  });
});

describe('reconstructNormalizedObservation', () => {
  test('reconstructs from persisted redacted fields only, never a raw body', () => {
    const n = svc.reconstructNormalizedObservation({
      sourceChannel: 'C2B_CONFIRMATION', businessShortCode: '174379', receiptNumber: 'R1',
      payloadDigest: 'd1', payloadRedacted: { amountCents: 500, billRefNumber: 'A1' },
    });
    expect(n).toMatchObject({ sourceChannel: 'C2B_CONFIRMATION', businessShortCode: '174379',
      receiptNumber: 'R1', payloadDigest: 'd1', ok: true, amountCents: 500, billRefNumber: 'A1' });
  });
  test('returns null when sourceChannel or payloadDigest is missing', () => {
    expect(svc.reconstructNormalizedObservation({ payloadDigest: 'd1' })).toBeNull();
    expect(svc.reconstructNormalizedObservation({ sourceChannel: 'C2B_CONFIRMATION' })).toBeNull();
  });
});
