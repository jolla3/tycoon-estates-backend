/**
 * G5 Tenant collection — MongoDB REPLICA-SET integration tests.
 * Requires a disposable tycoon_test_* replica set and TYCOON_ALLOW_DESTRUCTIVE_TEST_DB=1.
 * Skipped otherwise (describeWithMongo). These tests were AUTHORED but not executed in the
 * environment that produced them (no mongod available); do not cite them as passing evidence
 * until run.
 */
import '../setup.js';
import mongoose from 'mongoose';
import { describeWithMongo, connectTestDb, clearTestDb, disconnectTestDb } from '../helpers/db.js';
import { prepareG3TestIndexes } from '../helpers/g3Indexes.js';
import { Client } from '../../src/models/Client.js';
import { Estate } from '../../src/models/Estate.js';
import { House } from '../../src/models/House.js';
import { Tenant } from '../../src/models/Tenant.js';
import { Tenancy } from '../../src/models/Tenancy.js';
import { RentCharge } from '../../src/models/RentCharge.js';
import { Payment } from '../../src/models/Payment.js';
import { Ledger } from '../../src/models/Ledger.js';
import { PaymentAllocation } from '../../src/models/PaymentAllocation.js';
import { TenantCreditMovement } from '../../src/models/TenantCreditMovement.js';
import { settleTenantAccount, creditBalanceCents } from '../../src/services/tenantCredit.service.js';
import { PAYMENT_RECEIPT_TENANCY_INDEX as CH, PAYMENT_CREDIT_KEY_INDEX as CR } from '../../src/utils/paymentReceiptIndexReadiness.js';

describeWithMongo('G5 multi-Tenancy receipt settlement and Tenant credit', () => {
  let client, estate, tenant, otherTenant, tA, tB, houseA, houseB;

  const charge = (tenancy, house, period, due) => RentCharge.create({
    clientId: client._id, estateId: estate._id, houseId: house._id, tenantId: tenant._id, tenancyId: tenancy._id,
    period, chargeType: 'RENT', amountDueCents: due, amountPaidCents: 0, balanceCents: due, status: 'UNPAID',
    dueDate: new Date(`${period}-05T00:00:00+03:00`),
  });
  const settle = (amountCents, txId = new mongoose.Types.ObjectId()) => {
    const run = async () => {
      const session = await mongoose.startSession();
      try {
        let out;
        await session.withTransaction(async () => {
          out = await settleTenantAccount({
            clientId: client._id, estateId: estate._id, tenantId: tenant._id, session,
            receipt: { transactionId: txId, receiptNumber: 'QJK2ABCDEF', amountCents, transactionAt: new Date() },
          });
        });
        return out;
      } finally { await session.endSession(); }
    };
    return run();
  };

  beforeAll(async () => {
    await connectTestDb();
    await clearTestDb();
    await prepareG3TestIndexes();
    // G5 identity indexes (normally migration-installed) for the disposable DB only.
    await Payment.collection.createIndex(CH.key, { name: CH.name, unique: true, partialFilterExpression: CH.partialFilterExpression });
    await Payment.collection.createIndex(CR.key, { name: CR.name, unique: true, partialFilterExpression: CR.partialFilterExpression });
    await TenantCreditMovement.createIndexes();
  });
  afterAll(async () => { await clearTestDb(); await disconnectTestDb(); });

  beforeEach(async () => {
    // TenantCreditMovement is immutable; each test creates a fresh Tenant,
    // so previous movements remain isolated by tenantId.
    await Promise.all([Payment, PaymentAllocation, Ledger, RentCharge, Tenancy, Tenant, House, Estate, Client].map((m) => m.deleteMany({}).catch(() => {})));
    client = await Client.create({ name: 'G5 Client' });
    estate = await Estate.create({ clientId: client._id, name: 'G5 Estate', isActive: true });
    houseA = await House.create({ clientId: client._id, estateId: estate._id, houseNumber: 'A1', monthlyRent: 10000, status: 'occupied', isActive: true, dueDay: 5 });
    houseB = await House.create({ clientId: client._id, estateId: estate._id, houseNumber: 'B1', monthlyRent: 10000, status: 'occupied', isActive: true, dueDay: 5 });
    tenant = await Tenant.create({ clientId: client._id, estateId: estate._id, houseId: houseA._id, name: 'T One', phone: '+254700000001' });
    otherTenant = await Tenant.create({ clientId: client._id, estateId: estate._id, houseId: houseB._id, name: 'T Two', phone: '+254700000002' });
    tA = await Tenancy.create({ clientId: client._id, estateId: estate._id, houseId: houseA._id, tenantId: tenant._id, startAt: new Date('2025-01-01T00:00:00+03:00'), endAt: new Date('2026-03-01T00:00:00+03:00'), status: 'CLOSED', closeReason: 'MOVE_OUT' });
    tB = await Tenancy.create({ clientId: client._id, estateId: estate._id, houseId: houseB._id, tenantId: tenant._id, startAt: new Date('2026-03-01T00:00:00+03:00'), endAt: null, status: 'ACTIVE' });
  });

  test('one receipt -> oldest closed-Tenancy arrears first, then active; child Payments per Tenancy; reconciles', async () => {
    const old = await charge(tA, houseA, '2026-01', 30000);
    const cur = await charge(tB, houseB, '2026-04', 50000);
    const txId = new mongoose.Types.ObjectId();
    const out = await settle(60000, txId);
    expect(out.plan).toMatchObject({ receiptAppliedCents: 60000, newCreditCents: 0 });
    const pays = await Payment.find({ mpesaReceiptId: txId })
      .sort({ amountCents: 1, tenancyId: 1 });
    expect(pays.map((p) => [String(p.tenancyId), p.amountCents, p.origin])).toEqual([
      [String(tA._id), 30000, 'MPESA'],
      [String(tB._id), 30000, 'MPESA'],
    ].sort((a, b) => a[0].localeCompare(b[0])));
    expect((await RentCharge.findById(old._id)).balanceCents).toBe(0);
    expect((await RentCharge.findById(cur._id)).balanceCents).toBe(20000);
    const ledgerSum = (await Ledger.aggregate([{ $match: { entryType: 'PAYMENT' } }, { $group: { _id: null, t: { $sum: '$amountCents' } } }]))[0].t;
    expect(ledgerSum).toBe(60000);
  });

  test('surplus becomes Tenant credit and is applied automatically to the next receipt cycle', async () => {
    await charge(tB, houseB, '2026-04', 10000);
    await settle(25000);
    expect(await creditBalanceCents({ clientId: client._id, estateId: estate._id, tenantId: tenant._id })).toBe(15000);
    await charge(tB, houseB, '2026-05', 10000);
    const out = await settle(1000);
    expect(out.plan.creditAppliedCents).toBe(10000);
    expect(await creditBalanceCents({ clientId: client._id, estateId: estate._id, tenantId: tenant._id })).toBe(6000);
  });

  test('no cross-Tenant leakage: credit and charges of another Tenant are untouched', async () => {
    await RentCharge.create({ clientId: client._id, estateId: estate._id, houseId: houseB._id, tenantId: otherTenant._id, tenancyId: null, period: '2026-04', chargeType: 'RENT', amountDueCents: 9000, amountPaidCents: 0, balanceCents: 9000, status: 'UNPAID' });
    await settle(5000);
    expect(await creditBalanceCents({ clientId: client._id, estateId: estate._id, tenantId: otherTenant._id })).toBe(0);
    expect((await RentCharge.findOne({ tenantId: otherTenant._id })).balanceCents).toBe(9000);
  });

  test('replaying the same receipt id never creates a second Payment (unique child identity)', async () => {
    await charge(tB, houseB, '2026-04', 50000);
    const txId = new mongoose.Types.ObjectId();
    await settle(10000, txId);
    await expect(settle(10000, txId)).rejects.toBeTruthy();
    expect(await Payment.countDocuments({ mpesaReceiptId: txId })).toBe(1);
  });

  test('concurrent receipts serialize: no over-allocation, totals conserved', async () => {
    const c1 = await charge(tB, houseB, '2026-04', 10000);
    const results = await Promise.allSettled([settle(7000), settle(7000), settle(7000)]);
    const ok = results.filter((r) => r.status === 'fulfilled').length;
    expect(ok).toBeGreaterThanOrEqual(1);
    const c = await RentCharge.findById(c1._id);
    expect(c.amountPaidCents).toBeLessThanOrEqual(10000);
    const applied = (await PaymentAllocation.aggregate([{ $group: { _id: null, t: { $sum: '$amountCents' } } }]))[0].t;
    const credit = await creditBalanceCents({ clientId: client._id, estateId: estate._id, tenantId: tenant._id });
    expect(applied + credit).toBe(ok * 7000);
  });

  test('failure inside the transaction leaves no partial Payment/ledger/credit rows', async () => {
    await charge(tB, houseB, '2026-04', 10000);
    const txId = new mongoose.Types.ObjectId();
    const session = await mongoose.startSession();

    try {
      await expect(session.withTransaction(async () => {
        const result = await settleTenantAccount({
          clientId: client._id,
          estateId: estate._id,
          tenantId: tenant._id,
          session,
          receipt: {
            transactionId: txId,
            receiptNumber: 'X',
            amountCents: 15000,
            transactionAt: new Date(),
          },
        });

        // A 15,000-cent receipt against a 10,000-cent charge must
        // create a 5,000-cent surplus movement before the forced abort.
        expect(result.movements.map((m) => m.movementType)).toEqual(['RECEIPT_SURPLUS']);
        throw new Error('simulated downstream failure');
      })).rejects.toThrow('simulated');
    } finally {
      await session.endSession();
    }

    const scope = { clientId: client._id, estateId: estate._id, tenantId: tenant._id };
    expect(await Payment.countDocuments(scope)).toBe(0);
    expect(await Ledger.countDocuments(scope)).toBe(0);
    expect(await TenantCreditMovement.countDocuments({
      ...scope,
      mpesaTransactionId: txId,
    })).toBe(0);
  });
});
