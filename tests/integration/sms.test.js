import '../setup.js';
import { describeWithMongo, connectTestDb, clearTestDb, disconnectTestDb } from '../helpers/db.js';
import { Client } from '../../src/models/Client.js';
import { smsService } from '../../src/services/sms.service.js';
import { SmsMessage } from '../../src/models/SmsMessage.js';

describeWithMongo('SMS', () => {
  let client;
  beforeAll(connectTestDb);
  beforeEach(async () => { client = await Client.create({ name: 'SMS Client' }); });
  afterEach(clearTestDb);
  afterAll(disconnectTestDb);

  test('queueSms persists a queued SmsMessage', async () => {
    const job = await smsService.queueSms({ clientId: client._id, to: '+254700000000', message: 'Hello', type: 'general' });
    expect(job.status).toBe('queued');
  });

  test('a failed send is recorded with a failure reason (no Celcom credentials in test env)', async () => {
    await smsService.queueSms({ clientId: client._id, to: '+254700000000', message: 'Will fail', type: 'general' });
    await smsService.processQueuedBatch();

    const stored = await SmsMessage.findOne({ message: 'Will fail' });
    expect(['failed', 'unknown']).toContain(stored.status);
    expect(stored.failureReason).toBeTruthy();
  });
});

describeWithMongo('SMS atomic claiming (concurrency safety)', () => {
  let client;
  beforeAll(connectTestDb);
  beforeEach(async () => { client = await Client.create({ name: 'Concurrency Client' }); });
  afterEach(clearTestDb);
  afterAll(disconnectTestDb);

  test('two concurrent processQueuedBatch calls never both claim the same job', async () => {
    await smsService.queueSms({ clientId: client._id, to: '+254700000001', message: 'One', type: 'general' });
    await smsService.queueSms({ clientId: client._id, to: '+254700000002', message: 'Two', type: 'general' });
    await smsService.queueSms({ clientId: client._id, to: '+254700000003', message: 'Three', type: 'general' });

    // Simulate two workers racing to drain the same queue at once.
    const [countA, countB] = await Promise.all([smsService.processQueuedBatch(10), smsService.processQueuedBatch(10)]);

    // Together they must process exactly the 3 queued jobs — never more
    // (which would mean a job got claimed twice) — regardless of how the
    // 3 happen to split between the two concurrent calls.
    expect(countA + countB).toBe(3);

    const stillQueued = await SmsMessage.countDocuments({ status: 'queued' });
    expect(stillQueued).toBe(0);
  });
});
