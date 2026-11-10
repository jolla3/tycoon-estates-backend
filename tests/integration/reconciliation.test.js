import '../setup.js';
import { describeWithMongo, connectTestDb, clearTestDb, disconnectTestDb } from '../helpers/db.js';
import { jest } from '@jest/globals';
import { Client } from '../../src/models/Client.js';
import { Estate } from '../../src/models/Estate.js';
import { House } from '../../src/models/House.js';
import { HouseType } from '../../src/models/HouseType.js';
import { HouseTypePlanVersion } from '../../src/models/HouseTypePlanVersion.js';
import { Tenant } from '../../src/models/Tenant.js';
import { Tenancy } from '../../src/models/Tenancy.js';
import { BankAccount } from '../../src/models/BankAccount.js';
import { BankTransaction } from '../../src/models/BankTransaction.js';
import { Payment } from '../../src/models/Payment.js';
import { PaymentAllocation } from '../../src/models/PaymentAllocation.js';
import { RentCharge } from '../../src/models/RentCharge.js';
import { Ledger } from '../../src/models/Ledger.js';
import { reconciliationService } from '../../src/services/reconciliation.service.js';
import { transactionService } from '../../src/services/transaction.service.js';
import { tenancyService } from '../../src/services/tenancy.service.js';
import { encryptionUtil } from '../../src/utils/encryption.js';
import { money } from '../../src/utils/money.js';
import { dateUtil } from '../../src/utils/date.js';
import { Errors } from '../../src/utils/errors.js';
import { smsService } from '../../src/services/sms.service.js';
import { prepareG3TestIndexes } from '../helpers/g3Indexes.js';

describeWithMongo('Tenancy-scoped Bank reconciliation', () => {
  let client, estate, house, tenant, tenancy, bankAccount, houseType;
  let period;

  beforeAll(connectTestDb);
  beforeEach(async () => {
    await clearTestDb();
    await prepareG3TestIndexes();
    jest.spyOn(smsService, 'sendPaymentConfirmation').mockResolvedValue({ skipped: true });
    period = dateUtil.currentPeriod();

    client = await Client.create({ name: 'Recon Client' });
    estate = await Estate.create({ clientId: client._id, name: 'Recon Estate' });
    houseType = await HouseType.create({
      clientId: client._id,
      estateId: estate._id,
      name: 'Recon Standard',
      defaultRentCents: money.toCents(15000),
      defaultDueDay: 5,
      planVersion: 1,
      defaultBilling: [
        { chargeType: 'RENT', description: 'Rent', amountCents: money.toCents(15000), dueDay: 5 },
      ],
    });
    await HouseTypePlanVersion.create({
      clientId: client._id,
      estateId: estate._id,
      houseTypeId: houseType._id,
      version: 1,
      effectiveFromPeriod: '2020-01',
      lines: [
        { lineId: 'RENT:Rent', chargeType: 'RENT', description: 'Rent', amountCents: money.toCents(15000), dueDay: 5 },
      ],
    });
    house = await House.create({
      clientId: client._id,
      estateId: estate._id,
      houseNumber: 'A12',
      houseTypeId: houseType._id,
      billingSource: 'HOUSE_TYPE',
      monthlyRent: 15000,
      status: 'occupied',
      isActive: true,
    });
    tenant = await Tenant.create({
      clientId: client._id,
      estateId: estate._id,
      houseId: house._id,
      name: 'Jane Doe',
      phone: '+254700000000',
    });
    tenancy = await Tenancy.create({
      clientId: client._id,
      estateId: estate._id,
      houseId: house._id,
      tenantId: tenant._id,
      startAt: new Date('2020-01-01T00:00:00+03:00'),
      endAt: null,
      status: 'ACTIVE',
    });
    house.tenantId = tenant._id;
    await house.save();

    bankAccount = await BankAccount.create({
      clientId: client._id,
      estateId: estate._id,
      provider: 'COOP',
      accountNumberEncrypted: encryptionUtil.encrypt('123'),
      accountNumberHash: encryptionUtil.hashForLookup('123'),
      accountName: 'Test',
      connectionStatus: 'connected',
    });
  });
  afterEach(async () => {
    jest.restoreAllMocks();
    await clearTestDb();
  });
  afterAll(disconnectTestDb);

  async function makeTxn(overrides = {}) {
    return BankTransaction.create({
      clientId: client._id,
      estateId: estate._id,
      bankAccountId: bankAccount._id,
      provider: 'COOP',
      providerTransactionId: 'TXN-1',
      amountCents: money.toCents(15000),
      transactionDate: new Date(),
      paymentReference: 'A12',
      eventType: 'CREDIT',
      matchStatus: 'UNMATCHED',
      ...overrides,
    });
  }

  async function chargeFor(txn, targetTenancy = tenancy) {
    return RentCharge.findOne({
      clientId: client._id,
      tenancyId: targetTenancy._id,
      period: dateUtil.periodOf(txn.transactionDate),
      chargeType: 'RENT',
    });
  }

  test('matches the correct house and posts tenancy-owned Payment, Allocation, charge and Ledger rows', async () => {
    const txn = await makeTxn();
    const result = await reconciliationService.reconcile(txn);
    expect(result.matched).toBe(true);
    expect(result.payment).toBeTruthy();
    expect(String(result.payment.tenancyId)).toBe(String(tenancy._id));
    expect(String(result.payment.tenantId)).toBe(String(tenant._id));

    const charge = await chargeFor(txn);
    expect(charge.status).toBe('PAID');
    expect(charge.clientId.equals(client._id)).toBe(true);
    const allocations = await PaymentAllocation.find({ paymentId: result.payment._id }).lean();
    expect(allocations.length).toBe(1);
    expect(String(allocations[0].tenancyId)).toBe(String(tenancy._id));
    expect(allocations[0].amountCents).toBe(result.payment.amountCents);
    const ledger = await Ledger.find({ referenceType: 'Payment', referenceId: result.payment._id, entryType: 'PAYMENT' }).lean();
    expect(ledger).toHaveLength(1);
    expect(String(ledger[0].tenancyId)).toBe(String(tenancy._id));
  });

  test('a partial payment leaves the charge PARTIAL', async () => {
    const txn = await makeTxn({ amountCents: money.toCents(5000), providerTransactionId: 'TXN-PARTIAL' });
    const result = await reconciliationService.reconcile(txn);
    expect(result.matched).toBe(true);
    const charge = await chargeFor(txn);
    expect(charge.status).toBe('PARTIAL');
    expect(charge.amountPaidCents).toBe(money.toCents(5000));
    expect(charge.balanceCents).toBe(money.toCents(10000));
  });

  test('an overpayment is retained as a charge overpayment or unapplied tenancy credit', async () => {
    const txn = await makeTxn({ amountCents: money.toCents(20000), providerTransactionId: 'TXN-OVERPAY' });
    const result = await reconciliationService.reconcile(txn);
    expect(result.matched).toBe(true);
    const charge = await chargeFor(txn);
    const allocated = (await PaymentAllocation.find({ paymentId: result.payment._id }).lean())
      .reduce((sum, allocation) => sum + allocation.amountCents, 0);
    const unapplied = result.payment.amountCents - allocated;
    expect(charge.status === 'OVERPAID' || unapplied > 0).toBe(true);
    if (charge.status === 'OVERPAID') expect(charge.balanceCents).toBeLessThan(0);
    else expect(charge.status).toBe('PAID');
  });

  test('matches via a configured exact paymentReferences alias', async () => {
    house.paymentReferences = ['TENANT-REF-001'];
    await house.save();
    const txn = await makeTxn({ paymentReference: 'TENANT-REF-001', providerTransactionId: 'TXN-ALIAS' });
    const result = await reconciliationService.reconcile(txn);
    expect(result.matched).toBe(true);
    expect(String(result.house._id)).toBe(String(house._id));
  });

  test('a reference collision in another client cannot steal this client transaction', async () => {
    const otherClient = await Client.create({ name: 'Other Client' });
    const otherEstate = await Estate.create({ clientId: otherClient._id, name: 'Other Estate' });
    await House.create({ clientId: otherClient._id, estateId: otherEstate._id, houseNumber: 'A12', monthlyRent: 99999, isActive: true });
    const txn = await makeTxn({ providerTransactionId: 'TXN-CROSS-CLIENT' });
    const result = await reconciliationService.reconcile(txn);
    expect(result.matched).toBe(true);
    expect(String(result.house._id)).toBe(String(house._id));
    expect(String(result.payment.clientId)).toBe(String(client._id));
  });

  test('an unresolvable reference remains unmatched for manual review', async () => {
    const txn = await makeTxn({ paymentReference: 'ZZ-NO-SUCH-HOUSE', providerTransactionId: 'TXN-UNKNOWN' });
    const result = await reconciliationService.reconcile(txn);
    expect(result.matched).toBe(false);
    expect(txn.matchStatus).toBe('UNMATCHED');
    expect(txn.processingState).toBe('MANUAL_REVIEW');
    expect(await Payment.countDocuments({ bankTransactionId: txn._id })).toBe(0);
  });

  test('a debit transaction cannot be converted into a rent payment', async () => {
    const txn = await makeTxn({ eventType: 'DEBIT', providerTransactionId: 'TXN-DEBIT' });
    const result = await reconciliationService.reconcile(txn);
    expect(result.matched).toBe(false);
    expect(result.reason).toBe('not_a_credit');
    expect(txn.processingState).toBe('MANUAL_REVIEW');
    expect(await Payment.countDocuments({ bankTransactionId: txn._id })).toBe(0);
  });

  test('the same providerTransactionId cannot create two BankTransaction documents', async () => {
    await makeTxn({ providerTransactionId: 'DUP-1' });
    await expect(makeTxn({ providerTransactionId: 'DUP-1' })).rejects.toThrow();
  });

  test('reprocessing a matched transaction reuses one Payment and repairs its missing Ledger row', async () => {
    const txn = await makeTxn({ providerTransactionId: 'TXN-RETRY' });
    const first = await reconciliationService.reconcile(txn);
    expect(first.matched).toBe(true);
    expect(await Payment.countDocuments({ bankTransactionId: txn._id })).toBe(1);

    await Ledger.deleteOne({ referenceType: 'Payment', referenceId: first.payment._id, entryType: 'PAYMENT' });
    const retry = await reconciliationService.reconcile(txn);
    expect(retry.matched).toBe(true);
    expect(retry.reused).toBe(true);
    expect(await Payment.countDocuments({ bankTransactionId: txn._id })).toBe(1);
    expect(await Ledger.countDocuments({ referenceType: 'Payment', referenceId: first.payment._id, entryType: 'PAYMENT' })).toBe(1);
  });

  test('a historical payment still resolves after the tenant transfers to another estate', async () => {
    const historicalTenancyId = tenancy._id;
    const eventNow = new Date();
    const eventTime = new Date(
      eventNow.getFullYear(), eventNow.getMonth() - 1, 15, 12, 0, 0, 0
    );
    const targetEstate = await Estate.create({ clientId: client._id, name: 'New Estate' });
    const targetHouse = await House.create({
      clientId: client._id,
      estateId: targetEstate._id,
      houseNumber: 'B22',
      monthlyRent: 20000,
      isActive: true,
    });
    await tenancyService.moveToHouse(client._id, tenant._id, targetHouse._id);
    const closedHistorical = await Tenancy.findById(historicalTenancyId).lean();
    expect(closedHistorical.status).toBe('CLOSED');
    expect(String((await Tenant.findById(tenant._id)).estateId)).toBe(String(targetEstate._id));

    const txn = await makeTxn({
      providerTransactionId: 'TXN-HISTORICAL-TRANSFER',
      transactionDate: eventTime,
    });
    const result = await reconciliationService.reconcile(txn);
    expect(result.matched).toBe(true);
    expect(String(result.payment.tenancyId)).toBe(String(historicalTenancyId));
    expect(String(result.payment.estateId)).toBe(String(estate._id));
  });

  test('the tenancy endAt boundary is exclusive for transaction attribution', async () => {
    const endAt = new Date(Date.now() - 10 * 1000);
    tenancy.endAt = endAt;
    tenancy.status = 'CLOSED';
    await tenancy.save();
    const txn = await makeTxn({
      providerTransactionId: 'TXN-AT-END',
      transactionDate: endAt,
    });
    const result = await reconciliationService.reconcile(txn);
    expect(result.matched).toBe(false);
    expect(result.reason).toBe('no_unique_tenancy');
    expect(await Payment.countDocuments({ bankTransactionId: txn._id })).toBe(0);
  });

  test('manual assignment cannot target a house belonging to another client', async () => {
    const otherClient = await Client.create({ name: 'Other Client 2' });
    const otherEstate = await Estate.create({ clientId: otherClient._id, name: 'Other Estate 2' });
    const otherHouse = await House.create({ clientId: otherClient._id, estateId: otherEstate._id, houseNumber: 'X01', monthlyRent: 5000 });
    const txn = await makeTxn({ paymentReference: 'UNKNOWN-REF', providerTransactionId: 'TXN-MANUAL' });
    await reconciliationService.reconcile(txn);
    await expect(
      transactionService.assignToHouse(client._id, txn._id, otherHouse._id)
    ).rejects.toThrow(Errors.HouseNotFound().message);
  });

  test('manual assignment of a CREDIT transaction posts to the uniquely resolved Tenancy', async () => {
    const txn = await makeTxn({ paymentReference: 'UNKNOWN-REF', providerTransactionId: 'TXN-MANUAL-VALID' });
    await reconciliationService.reconcile(txn);
    const assigned = await transactionService.assignToHouse(client._id, txn._id, house._id);
    expect(assigned.matchStatus).toBe('MATCHED');
    expect(String(assigned.matchedTenancyId)).toBe(String(tenancy._id));
    const payment = await Payment.findOne({ bankTransactionId: txn._id });
    expect(payment).toBeTruthy();
    expect(String(payment.tenancyId)).toBe(String(tenancy._id));
  });
});
