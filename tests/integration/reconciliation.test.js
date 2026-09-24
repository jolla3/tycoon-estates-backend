import '../setup.js';
import { describeWithMongo, connectTestDb, clearTestDb, disconnectTestDb } from '../helpers/db.js';
import { Client } from '../../src/models/Client.js';
import { Estate } from '../../src/models/Estate.js';
import { House } from '../../src/models/House.js';
import { Tenant } from '../../src/models/Tenant.js';
import { BankAccount } from '../../src/models/BankAccount.js';
import { BankTransaction } from '../../src/models/BankTransaction.js';
import { Payment } from '../../src/models/Payment.js';
import { reconciliationService } from '../../src/services/reconciliation.service.js';
import { transactionService } from '../../src/services/transaction.service.js';
import { encryptionUtil } from '../../src/utils/encryption.js';
import { money } from '../../src/utils/money.js';
import { Errors } from '../../src/utils/errors.js';

describeWithMongo('Reconciliation', () => {
  let client, estate, house, tenant, bankAccount;

  beforeAll(connectTestDb);
  beforeEach(async () => {
    client = await Client.create({ name: 'Recon Client' });
    estate = await Estate.create({ clientId: client._id, name: 'Recon Estate' });
    house = await House.create({ clientId: client._id, estateId: estate._id, houseNumber: 'A12', monthlyRent: 15000, status: 'occupied' });
    tenant = await Tenant.create({ clientId: client._id, estateId: estate._id, houseId: house._id, name: 'Jane Doe', phone: '+254700000000' });
    house.tenantId = tenant._id;
    await house.save();
    bankAccount = await BankAccount.create({
      clientId: client._id, estateId: estate._id, provider: 'COOP',
      accountNumberEncrypted: encryptionUtil.encrypt('123'), accountNumberHash: encryptionUtil.hashForLookup('123'),
      accountName: 'Test', connectionStatus: 'connected',
    });
  });
  afterEach(clearTestDb);
  afterAll(disconnectTestDb);

  async function makeTxn(overrides = {}) {
    return BankTransaction.create({
      clientId: client._id,
      estateId: estate._id,
      bankAccountId: bankAccount._id,
      provider: 'COOP',
      providerTransactionId: overrides.providerTransactionId || 'TXN-1',
      amountCents: money.toCents(15000),
      transactionDate: new Date(),
      paymentReference: 'A12',
      eventType: 'CREDIT',
      matchStatus: 'UNMATCHED',
      ...overrides,
    });
  }

  test('matches a transaction to the correct house by reference and marks PAID', async () => {
    const txn = await makeTxn();
    const result = await reconciliationService.reconcile(txn);
    expect(result.matched).toBe(true);
    expect(result.rentCharge.status).toBe('PAID');
    expect(result.rentCharge.clientId.equals(client._id)).toBe(true);
  });

  test('a partial payment leaves the charge PARTIAL, not PAID', async () => {
    const txn = await makeTxn({ amountCents: money.toCents(5000) });
    const result = await reconciliationService.reconcile(txn);
    expect(result.rentCharge.status).toBe('PARTIAL');
  });

  test('an overpayment is marked OVERPAID, not silently capped', async () => {
    const txn = await makeTxn({ amountCents: money.toCents(20000) });
    const result = await reconciliationService.reconcile(txn);
    expect(result.rentCharge.status).toBe('OVERPAID');
  });

  test('matches via a configured paymentReferences alias when the reference is not the exact house number', async () => {
    house.paymentReferences = ['TENANT-REF-001'];
    await house.save();

    const txn = await makeTxn({ paymentReference: 'TENANT-REF-001', providerTransactionId: 'TXN-ALIAS' });
    const result = await reconciliationService.reconcile(txn);
    expect(result.matched).toBe(true);
    expect(result.house._id.equals(house._id)).toBe(true);
  });

  test('a reference matching another client\'s house number is never matched — clientId scoping, not string luck', async () => {
    const otherClient = await Client.create({ name: 'Other Client' });
    const otherEstate = await Estate.create({ clientId: otherClient._id, name: 'Other Estate' });
    // Deliberately the SAME house number as `house` above, under a DIFFERENT client.
    await House.create({ clientId: otherClient._id, estateId: otherEstate._id, houseNumber: 'A12', monthlyRent: 99999, isActive: true });

    const txn = await makeTxn({ providerTransactionId: 'TXN-CROSS-CLIENT' });
    const result = await reconciliationService.reconcile(txn);
    expect(result.matched).toBe(true);
    expect(result.house._id.equals(house._id)).toBe(true); // matched OUR house, not the other client's
  });

  test('an unresolvable reference is left UNMATCHED for manual review, never guessed', async () => {
    const txn = await makeTxn({ paymentReference: 'ZZ-NO-SUCH-HOUSE', providerTransactionId: 'TXN-2' });
    const result = await reconciliationService.reconcile(txn);
    expect(result.matched).toBe(false);
    expect(txn.matchStatus).toBe('UNMATCHED');
  });

  test('the same providerTransactionId can never create two BankTransaction docs (idempotency)', async () => {
    await makeTxn({ providerTransactionId: 'DUP-1' });
    await expect(makeTxn({ providerTransactionId: 'DUP-1' })).rejects.toThrow();
  });

  test('reconciling a transaction never creates more than one Payment for it', async () => {
    const txn = await makeTxn({ providerTransactionId: 'TXN-3' });
    await reconciliationService.reconcile(txn);
    const payments = await Payment.find({ bankTransactionId: txn._id });
    expect(payments.length).toBe(1);
  });

  test('manual assignment of an unmatched transaction cannot target a house belonging to a different client', async () => {
    const otherClient = await Client.create({ name: 'Other Client 2' });
    const otherEstate = await Estate.create({ clientId: otherClient._id, name: 'Other Estate 2' });
    const otherHouse = await House.create({ clientId: otherClient._id, estateId: otherEstate._id, houseNumber: 'X01', monthlyRent: 5000 });

    const txn = await makeTxn({ paymentReference: 'UNKNOWN-REF', providerTransactionId: 'TXN-MANUAL' });
    await reconciliationService.reconcile(txn); // stays UNMATCHED

    await expect(transactionService.assignToHouse(client._id, txn._id, otherHouse._id)).rejects.toThrow(Errors.HouseNotFound().message);
  });
});
