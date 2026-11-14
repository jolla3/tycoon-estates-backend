// Real-MongoDB verification of inbox idempotency. Skipped unless MONGODB_URI points at a disposable
// tycoon_test_* replica set AND TYCOON_ALLOW_DESTRUCTIVE_TEST_DB=1. Creates the partial unique index
// on the TEST database only; touches no provider, no Payment/Ledger, no MpesaTransaction.
import '../setup.js';
import mongoose from 'mongoose';
import { jest, beforeAll, afterAll, describe, test, expect } from '@jest/globals';
import { describeWithMongo, connectTestDb, disconnectTestDb } from '../helpers/db.js';

jest.setTimeout(60000);

describeWithMongo('inbox idempotency (real MongoDB)', () => {
  let svc; let Event; let MpesaTransaction; let INDEX;
  const obs = (o = {}) => ({ sourceChannel: 'C2B_CONFIRMATION', businessShortCode: '174379',
    receiptNumber: 'RCPINT1', payloadDigest: 'd1', ok: true, ...o });

  beforeAll(async () => {
    await connectTestDb();
    svc = await import('../../src/services/mpesa/mpesaIngestion.service.js');
    ({ MpesaIngestionEvent: Event } = await import('../../src/models/MpesaIngestionEvent.js'));
    ({ MpesaTransaction } = await import('../../src/models/MpesaTransaction.js'));
    ({ INBOX_IDEMPOTENCY_INDEX: INDEX } = await import('../../src/utils/mpesaIndexReadiness.js'));
    await mongoose.connection.collection(INDEX.collection).createIndex(INDEX.key, {
      name: INDEX.name, unique: true, partialFilterExpression: INDEX.partialFilterExpression });
  });
  afterAll(async () => { await disconnectTestDb(); });

  const ready = () => true;

  test('concurrent identical deliveries produce exactly one row', async () => {
    const res = await Promise.all(Array.from({ length: 20 }, () => svc.persistIngestionObservation(obs(), { readyCheck: ready })));
    expect(res.filter((r) => r.outcome === 'created')).toHaveLength(1);
    expect(await Event.countDocuments({ receiptNumber: 'RCPINT1' })).toBe(1);
  });

  test('conflicting replay quarantines and preserves the original', async () => {
    const r = await svc.persistIngestionObservation(obs({ payloadDigest: 'd2' }), { readyCheck: ready });
    expect(r.outcome).toBe('conflict');
    const doc = await Event.findOne({ receiptNumber: 'RCPINT1' }).lean();
    expect(doc).toMatchObject({ state: 'QUARANTINED', quarantineCategory: 'replay_conflict', payloadDigest: 'd1' });
    expect(doc.conflictCount).toBeGreaterThanOrEqual(1);
    expect(doc.conflictDigests).toContain('d2');
  });

  test('no canonical MpesaTransaction is written while canonical identity is unverified', async () => {
    expect(await MpesaTransaction.countDocuments({ receiptNumber: 'RCPINT1' })).toBe(0);
  });
});
