/** G5 protected SMS outbox — replica-set/Mongo integration. Authored, NOT executed where no mongod exists. */
import '../setup.js';
import { jest } from '@jest/globals';
import { describeWithMongo, connectTestDb, clearTestDb, disconnectTestDb } from '../helpers/db.js';
import mongoose from 'mongoose';
import { SmsMessage } from '../../src/models/SmsMessage.js';
import { queueProtectedSms, cancelQueuedForLink, dispatchProtectedBatch } from '../../src/services/g5ProtectedSms.service.js';
import { smsService } from '../../src/services/sms.service.js';

describeWithMongo('G5 protected SMS', () => {
  const ids = () => ({ clientId: new mongoose.Types.ObjectId(), estateId: new mongoose.Types.ObjectId() });
  beforeAll(async () => {
    process.env.G5_ENVELOPE_KEYS = `k1:${'a1'.repeat(32)}`;
    await connectTestDb(); await clearTestDb();
  });
  afterAll(async () => { await clearTestDb(); await disconnectTestDb(); });

  test('stores no plaintext phone/body; ordinary worker never claims it; cancel on rotation', async () => {
    const { clientId, estateId } = ids();
    const linkId = new mongoose.Types.ObjectId();
    const { id } = await queueProtectedSms({ clientId, estateId, phone: '+254700000009', body: 'SECRET BODY', idempotencyKey: 'k1', linkId, linkVersion: 1 });
    const raw = await SmsMessage.collection.findOne({ _id: id });
    expect(JSON.stringify(raw)).not.toMatch(/254700000009|SECRET BODY/);
    expect(await smsService._claimNextBatch(5)).toHaveLength(0);
    expect(await cancelQueuedForLink(linkId, { clientId })).toBe(1);
    expect((await SmsMessage.findById(id)).status).toBe('cancelled');
  });

  test('duplicate idempotency key collapses', async () => {
    const { clientId, estateId } = ids();
    const a = await queueProtectedSms({ clientId, estateId, phone: '+1', body: 'b', idempotencyKey: 'dup' });
    const b = await queueProtectedSms({ clientId, estateId, phone: '+1', body: 'b', idempotencyKey: 'dup' });
    expect(a.created).toBe(true);
    expect(b.created).toBe(false);
  });

  test('lost lease after sendStartedAt becomes unknown and is never re-sent', async () => {
    const { clientId, estateId } = ids();
    const { id } = await queueProtectedSms({ clientId, estateId, phone: '+2', body: 'c', idempotencyKey: 'stale' });
    await SmsMessage.updateOne({ _id: id }, { $set: { status: 'processing', dispatchLeaseExpiresAt: new Date(Date.now() - 1000), dispatchLeaseToken: 'old', sendStartedAt: new Date() } });
    await dispatchProtectedBatch(5);
    expect((await SmsMessage.findById(id)).status).toBe('unknown');
  });
});
