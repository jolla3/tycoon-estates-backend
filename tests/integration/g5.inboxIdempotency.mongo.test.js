// Real-MongoDB verification of inbox idempotency and the canonical fail-closed guard. Skipped
// unless MONGODB_URI points at a disposable tycoon_test_* replica set AND
// TYCOON_ALLOW_DESTRUCTIVE_TEST_DB=1. Creates the partial unique index on the TEST database only;
// touches no provider, no Payment/Ledger, no live callback route, no financial posting.
import '../setup.js';
import crypto from 'crypto';
import mongoose from 'mongoose';
import { jest, beforeAll, afterAll, beforeEach, describe, test, expect } from '@jest/globals';
import { describeWithMongo, connectTestDb, disconnectTestDb, clearTestDb } from '../helpers/db.js';

jest.setTimeout(60000);

describeWithMongo('inbox idempotency (real MongoDB)', () => {
  let svc; let Event; let MpesaTransaction; let INDEX;

  beforeAll(async () => {
    await connectTestDb();
    svc = await import('../../src/services/mpesa/mpesaIngestion.service.js');
    ({ MpesaIngestionEvent: Event } = await import('../../src/models/MpesaIngestionEvent.js'));
    ({ MpesaTransaction } = await import('../../src/models/MpesaTransaction.js'));
    ({ INBOX_IDEMPOTENCY_INDEX: INDEX } = await import('../../src/utils/mpesaIndexReadiness.js'));
    await mongoose.connection.collection(INDEX.collection).createIndex(INDEX.key, {
      name: INDEX.name, unique: true, partialFilterExpression: INDEX.partialFilterExpression,
    });
  });
  afterAll(async () => { await disconnectTestDb(); });
  beforeEach(async () => { await clearTestDb(); });

  const ready = () => true;
  // A fresh receipt per test run makes repeated executions (and parallel CI runs against the
  // same disposable DB) collision-free without ever depending on clearTestDb() having run first.
  const freshReceipt = () => `RCPINT-${crypto.randomBytes(6).toString('hex')}`;
  const obs = (receiptNumber, o = {}) => ({
    sourceChannel: 'C2B_CONFIRMATION', businessShortCode: '174379',
    receiptNumber, payloadDigest: 'd1', ok: true, ...o,
  });

  test('concurrent identical deliveries produce exactly one row', async () => {
    const receiptNumber = freshReceipt();
    const res = await Promise.all(
      Array.from({ length: 20 }, () => svc.persistIngestionObservation(obs(receiptNumber), { readyCheck: ready }))
    );
    expect(res.filter((r) => r.outcome === 'created')).toHaveLength(1);
    expect(res.filter((r) => r.outcome === 'duplicate')).toHaveLength(19);
    expect(await Event.countDocuments({ receiptNumber })).toBe(1);
    const doc = await Event.findOne({ receiptNumber }).lean();
    expect(doc.replayCount).toBe(19);
  });

  test('concurrent conflicting deliveries: one row, original preserved, conflict evidence persisted', async () => {
    const receiptNumber = freshReceipt();
    const digests = ['d1', 'd2', 'd3', 'd4', 'd5'];
    const res = await Promise.all(
      digests.map((d) => svc.persistIngestionObservation(obs(receiptNumber, { payloadDigest: d }), { readyCheck: ready }))
    );
    expect(await Event.countDocuments({ receiptNumber })).toBe(1);
    expect(res.filter((r) => r.outcome === 'created')).toHaveLength(1);
    expect(res.filter((r) => r.outcome === 'conflict')).toHaveLength(4);

    const doc = await Event.findOne({ receiptNumber }).lean();
    // The FIRST delivery to win the race is the one whose payloadDigest survives as "original";
    // we don't know which digest that was ahead of time, so assert invariants instead of a value.
    expect(digests).toContain(doc.payloadDigest);
    expect(doc.state).toBe('QUARANTINED');
    expect(doc.quarantineCategory).toBe('replay_conflict');
    expect(doc.conflictCount).toBe(4);
    expect(doc.conflictDigests.length).toBeGreaterThan(0);
    expect(doc.conflictDigests.length).toBeLessThanOrEqual(5);
    // Every conflicting digest recorded is one of the real contenders, and never the surviving one.
    for (const d of doc.conflictDigests) {
      expect(digests).toContain(d);
      expect(d).not.toBe(doc.payloadDigest);
    }
  });

  test('conflicting replay after a successful claim fences the active lease', async () => {
    const receiptNumber = freshReceipt();
    const { event } = await svc.persistIngestionObservation(obs(receiptNumber), { readyCheck: ready });
    const claim = await svc.claimIngestionEvent(event._id);
    expect(claim).not.toBeNull();

    const conflictResult = await svc.persistIngestionObservation(
      obs(receiptNumber, { payloadDigest: 'different' }), { readyCheck: ready }
    );
    expect(conflictResult.outcome).toBe('conflict');

    // The lease this worker is holding is now fenced: its token-conditional completion can no
    // longer match (state is no longer PROCESSING under that token), so it cannot resurrect the row.
    const completed = await svc.completeIngestionEvent(event._id, claim.leaseToken, { state: 'PROCESSED' });
    expect(completed).toBeNull();

    const doc = await Event.findOne({ receiptNumber }).lean();
    expect(doc.state).toBe('QUARANTINED');
    expect(doc.quarantineCategory).toBe('replay_conflict');
    expect(doc.processingLeaseToken).toBeNull();
  });

  test('canonical fail-closed: claimIngestionEvent + processClaimedEvent write no MpesaTransaction', async () => {
    const receiptNumber = freshReceipt();
    const { event } = await svc.persistIngestionObservation(obs(receiptNumber), { readyCheck: ready });
    const claim = await svc.claimIngestionEvent(event._id);
    expect(claim).not.toBeNull();

    const result = await svc.processClaimedEvent(claim.event, claim.leaseToken, obs(receiptNumber));
    expect(result).toMatchObject({ quarantined: true, reason: 'canonical_identity_unverified', transaction: null });

    const doc = await Event.findOne({ receiptNumber }).lean();
    expect(doc.state).toBe('QUARANTINED');
    expect(doc.quarantineCategory).toBe('canonical_identity_unverified');
    expect(doc.normalizedTransactionId).toBeNull();
    expect(await MpesaTransaction.countDocuments({ receiptNumber })).toBe(0);
  });

  test('clearTestDb() isolates each test: no leftover rows from a previous test', async () => {
    expect(await Event.countDocuments({})).toBe(0);
    expect(await MpesaTransaction.countDocuments({})).toBe(0);
  });
});
