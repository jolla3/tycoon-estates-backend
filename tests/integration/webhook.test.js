import '../setup.js';
process.env.COOP_INS_BASIC_SECRET = 'test-ins-secret';

import request from 'supertest';
import { describeWithMongo, connectTestDb, clearTestDb, disconnectTestDb } from '../helpers/db.js';
import { createApp } from '../../src/app.js';
import { Client } from '../../src/models/Client.js';
import { Estate } from '../../src/models/Estate.js';
import { House } from '../../src/models/House.js';
import { BankAccount } from '../../src/models/BankAccount.js';
import { BankTransaction } from '../../src/models/BankTransaction.js';
import { encryptionUtil } from '../../src/utils/encryption.js';

describeWithMongo("Co-op SendTransactionINS webhook — multi-client account resolution", () => {
  let app, clientA, clientB, estateB, accountB, houseB;

  beforeAll(async () => {
    await connectTestDb();
    app = createApp();
  });
  beforeEach(async () => {
    clientA = await Client.create({ name: 'Client A' });
    clientB = await Client.create({ name: 'Client B' });
    const estateA = await Estate.create({ clientId: clientA._id, name: 'Estate A' });
    estateB = await Estate.create({ clientId: clientB._id, name: 'Estate B' });

    await BankAccount.create({
      clientId: clientA._id, estateId: estateA._id, provider: 'COOP', connectionStatus: 'connected',
      accountNumberEncrypted: encryptionUtil.encrypt('11111111111111'),
      accountNumberHash: encryptionUtil.hashForLookup('11111111111111'),
      accountName: 'Client A Account',
    });
    accountB = await BankAccount.create({
      clientId: clientB._id, estateId: estateB._id, provider: 'COOP', connectionStatus: 'connected',
      accountNumberEncrypted: encryptionUtil.encrypt('22222222222222'),
      accountNumberHash: encryptionUtil.hashForLookup('22222222222222'),
      accountName: 'Client B Account',
    });

    houseB = await House.create({ clientId: clientB._id, estateId: estateB._id, houseNumber: 'B01', monthlyRent: 20000, status: 'occupied' });
  });
  afterEach(clearTestDb);
  afterAll(disconnectTestDb);

  test("a SendTransactionINS notification for Client B's account is filed under Client B, not Client A", async () => {
    // Documented SendTransactionINS body shape, including its
    // compact-format TransactionDate (verified against the supplied docs).
    const payload = {
      MessageReference: '40ca18c6765086089a1',
      MessageDateTime: '2026-08-31T14:15:22Z',
      PaymentRef: 'B01',
      AccountNumber: '22222222222222', // Client B's account
      Amount: 20000,
      TransactionDate: '20260831141522',
      EventType: 'CREDIT',
      Currency: 'KES',
      Narration: 'Rent payment B01',
      TransactionId: 'WEBHOOK-TXN-1',
    };

    const res = await request(app)
      .post('/api/v1/webhooks/banks/coop/transactions')
      .set('basic', 'test-ins-secret')
      .send(payload)
      .expect(200);

    expect(res.body.received).toBe(true);

    const stored = await BankTransaction.findOne({ providerTransactionId: 'WEBHOOK-TXN-1' });
    expect(stored.clientId.equals(clientB._id)).toBe(true);
    expect(stored.bankAccountId.equals(accountB._id)).toBe(true);
    expect(stored.matchedHouseId?.equals(houseB._id)).toBe(true);
  });

  test('a payload missing AccountNumber is rejected loudly, not silently misrouted', async () => {
    const payload = { MessageReference: 'ref', TransactionId: 'WEBHOOK-TXN-2', PaymentRef: 'B01', Amount: 1000, TransactionDate: '20260101000000' };

    const res = await request(app)
      .post('/api/v1/webhooks/banks/coop/transactions')
      .set('basic', 'test-ins-secret')
      .send(payload)
      .expect(422);

    expect(res.body.reason).toBe('account_number_not_found_in_payload');
  });

  test('an invalid Basic credential is rejected', async () => {
    await request(app)
      .post('/api/v1/webhooks/banks/coop/transactions')
      .set('basic', 'wrong-secret')
      .send({ TransactionId: 'X', AccountNumber: '22222222222222' })
      .expect(401);
  });

  test('the same TransactionId delivered twice never creates a second BankTransaction (idempotency)', async () => {
    const payload = {
      MessageReference: 'ref2', TransactionId: 'WEBHOOK-TXN-DUP', AccountNumber: '22222222222222',
      Amount: 5000, TransactionDate: '20260101000000', EventType: 'CREDIT', PaymentRef: 'UNKNOWN-REF',
    };

    await request(app).post('/api/v1/webhooks/banks/coop/transactions').set('basic', 'test-ins-secret').send(payload).expect(200);
    await request(app).post('/api/v1/webhooks/banks/coop/transactions').set('basic', 'test-ins-secret').send(payload).expect(200);

    const count = await BankTransaction.countDocuments({ providerTransactionId: 'WEBHOOK-TXN-DUP' });
    expect(count).toBe(1);
  });
});
