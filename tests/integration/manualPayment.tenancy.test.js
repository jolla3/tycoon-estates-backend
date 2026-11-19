/**
 * Manual payment tenancy attribution (DB-backed).
 * Same requirements as g3.accounting.test.js: disposable replica-set MONGODB_URI,
 * TYCOON_ALLOW_DESTRUCTIVE_TEST_DB=1 and a tycoon_test_* database. Skipped otherwise.
 * NOTE: authored without a MongoDB available to the author; not yet executed.
 */
import '../setup.js';
import { describeWithMongo, connectTestDb, clearTestDb, disconnectTestDb } from '../helpers/db.js';
import { prepareG3TestIndexes } from '../helpers/g3Indexes.js';
import { Client } from '../../src/models/Client.js';
import { Estate } from '../../src/models/Estate.js';
import { House } from '../../src/models/House.js';
import { HouseType } from '../../src/models/HouseType.js';
import { HouseTypePlanVersion } from '../../src/models/HouseTypePlanVersion.js';
import { Tenant } from '../../src/models/Tenant.js';
import { Tenancy } from '../../src/models/Tenancy.js';
import { RentCharge } from '../../src/models/RentCharge.js';
import { Payment } from '../../src/models/Payment.js';
import { Ledger } from '../../src/models/Ledger.js';
import { PaymentAllocation } from '../../src/models/PaymentAllocation.js';
import { paymentService } from '../../src/services/payment.service.js';
import { ledgerService } from '../../src/services/ledger.service.js';
import { jest } from '@jest/globals';

describeWithMongo('manual payment tenancy attribution', () => {
  let client, otherClient, estate, house, otherHouse, tenantA, tenantB, tenancyA, tenancyB;
  const HIST = '2026-06'; // fully covered by tenancy A (closed 2026-07-01)
  const CUR = '2026-07'; // fully covered by tenancy B

  beforeAll(connectTestDb);
  afterAll(disconnectTestDb);

  beforeEach(async () => {
    await clearTestDb();
    await prepareG3TestIndexes();
    client = await Client.create({ name: 'MP Client' });
    otherClient = await Client.create({ name: 'Other Client' });
    estate = await Estate.create({ clientId: client._id, name: 'E', isActive: true });
    const ht = await HouseType.create({
      clientId: client._id, estateId: estate._id, name: 'Studio', defaultRentCents: 1000000, defaultDueDay: 5, planVersion: 1,
      defaultBilling: [{ chargeType: 'RENT', description: 'Rent', amountCents: 1000000, dueDay: 5 }],
    });
    await HouseTypePlanVersion.create({
      clientId: client._id, estateId: estate._id, houseTypeId: ht._id, version: 1, effectiveFromPeriod: '2026-01',
      lines: [{ lineId: 'RENT:Rent', chargeType: 'RENT', description: 'Rent', amountCents: 1000000, dueDay: 5 }],
    });
    const mkHouse = (n) => House.create({
      clientId: client._id, estateId: estate._id, houseNumber: n, houseTypeId: ht._id,
      billingSource: 'HOUSE_TYPE', monthlyRent: 10000, status: 'occupied', isActive: true, dueDay: 5,
    });
    house = await mkHouse('MP-1');
    otherHouse = await mkHouse('MP-2');
    const mkTenant = (name) => Tenant.create({ clientId: client._id, estateId: estate._id, houseId: house._id, name, phone: '+254711000003' });
    tenantA = await mkTenant('Alice Former');
    tenantB = await mkTenant('Bob Current');
    tenancyA = await Tenancy.create({
      clientId: client._id, estateId: estate._id, houseId: house._id, tenantId: tenantA._id,
      startAt: new Date('2026-01-01T00:00:00+03:00'), endAt: new Date('2026-07-01T00:00:00+03:00'), status: 'CLOSED', closeReason: 'MOVE_OUT',
    });
    tenancyB = await Tenancy.create({
      clientId: client._id, estateId: estate._id, houseId: house._id, tenantId: tenantB._id,
      startAt: new Date('2026-07-01T00:00:00+03:00'), endAt: null, status: 'ACTIVE',
    });
    house.tenantId = tenantB._id;
    await house.save();
  });

  const record = (body) => paymentService.recordManual(client._id, { houseId: String(house._id), amountCents: 500000, ...body });

  test('historic period auto-resolves to the former tenancy, not the current tenant', async () => {
    const { payment } = await record({ period: HIST, paymentReference: 'H-1' });
    expect(String(payment.tenancyId)).toBe(String(tenancyA._id));
    expect(String(payment.tenantId)).toBe(String(tenantA._id));
    const charges = await RentCharge.find({ houseId: house._id, period: HIST });
    expect(charges.length).toBeGreaterThan(0);
    expect(charges.every((c) => String(c.tenancyId) === String(tenancyA._id))).toBe(true);
    const led = await Ledger.find({ referenceType: 'Payment', referenceId: payment._id });
    expect(led).toHaveLength(1);
    expect(String(led[0].tenancyId)).toBe(String(tenancyA._id));
    // The current tenancy is untouched.
    expect(await RentCharge.countDocuments({ tenancyId: tenancyB._id })).toBe(0);
  });

  test('current period resolves to the current tenancy', async () => {
    const { payment } = await record({ period: CUR, paymentReference: 'C-1' });
    expect(String(payment.tenancyId)).toBe(String(tenancyB._id));
  });

  test('no covering tenancy fails closed and writes nothing', async () => {
    await expect(record({ period: '2025-01', paymentReference: 'N-1' })).rejects.toMatchObject({ code: 'INVALID_REQUEST' });
    expect(await Payment.countDocuments({})).toBe(0);
    expect(await Ledger.countDocuments({ referenceType: 'Payment' })).toBe(0);
  });

  test('explicit tenancy that does not cover the period is rejected', async () => {
    await expect(record({ period: HIST, tenancyId: String(tenancyB._id), paymentReference: 'X-1' })).rejects.toMatchObject({ code: 'INVALID_REQUEST' });
    expect(await Payment.countDocuments({})).toBe(0);
  });

  test('explicit tenancy of another house is rejected', async () => {
    const stray = await Tenancy.create({
      clientId: client._id, estateId: estate._id, houseId: otherHouse._id, tenantId: tenantA._id,
      startAt: new Date('2026-01-01T00:00:00+03:00'), endAt: null, status: 'ACTIVE',
    });
    await expect(record({ period: CUR, tenancyId: String(stray._id), paymentReference: 'X-2' })).rejects.toMatchObject({ code: 'INVALID_REQUEST' });
  });

  test('explicit tenancy of another client is rejected', async () => {
    const foreignEstate = await Estate.create({ clientId: otherClient._id, name: 'F', isActive: true });
    const foreignHouse = await House.create({ clientId: otherClient._id, estateId: foreignEstate._id, houseNumber: 'F-1', status: 'occupied', isActive: true, monthlyRent: 1 });
    const foreignTenant = await Tenant.create({ clientId: otherClient._id, estateId: foreignEstate._id, houseId: foreignHouse._id, name: 'F', phone: '+254711000009' });
    const foreign = await Tenancy.create({
      clientId: otherClient._id, estateId: foreignEstate._id, houseId: foreignHouse._id, tenantId: foreignTenant._id,
      startAt: new Date('2026-01-01T00:00:00+03:00'), endAt: null, status: 'ACTIVE',
    });
    await expect(record({ period: CUR, tenancyId: String(foreign._id), paymentReference: 'X-3' })).rejects.toMatchObject({ code: 'INVALID_REQUEST' });
  });

  test('tenantId that does not own the resolved tenancy is rejected', async () => {
    await expect(record({ period: HIST, tenantId: String(tenantB._id), paymentReference: 'X-4' })).rejects.toMatchObject({ code: 'INVALID_REQUEST', message: expect.stringMatching(/tenantId does not match/) });
    expect(await Payment.countDocuments({})).toBe(0);
  });

  test('same reference and details is idempotent; different amount conflicts', async () => {
    const first = await record({ period: HIST, paymentReference: 'D-1' });
    const again = await record({ period: HIST, paymentReference: 'D-1' });
    expect(again.reused).toBe(true);
    expect(String(again.payment._id)).toBe(String(first.payment._id));
    await expect(record({ period: HIST, paymentReference: 'D-1', amountCents: 1 })).rejects.toMatchObject({ code: 'CONFLICT' });
    expect(await Payment.countDocuments({})).toBe(1);
  });

  test('manualOptions lists readable choices and a default only when unique', async () => {
    const hist = await paymentService.manualOptions(client._id, null, { houseId: String(house._id), period: HIST });
    expect(hist.resolution).toBe('UNIQUE');
    expect(hist.defaultTenancyId).toBe(String(tenancyA._id));
    expect(hist.options.map((o) => o.tenantName).sort()).toEqual(['Alice Former', 'Bob Current']);
    const none = await paymentService.manualOptions(client._id, null, { houseId: String(house._id), period: '2025-01' });
    expect(none.resolution).toBe('NONE');
    expect(none.defaultTenancyId).toBeNull();
  });

  test('two eligible tenancies: rejected until tenancyId is given, then only that tenancy is charged', async () => {
    const tenantC = await Tenant.create({ clientId: client._id, estateId: estate._id, houseId: house._id, name: 'Carol Overlap', phone: '+254711000004' });
    const overlap = await Tenancy.create({
      clientId: client._id, estateId: estate._id, houseId: house._id, tenantId: tenantC._id,
      startAt: new Date('2026-01-01T00:00:00+03:00'), endAt: new Date('2026-07-01T00:00:00+03:00'), status: 'CLOSED', closeReason: 'MOVE_OUT',
    });
    await expect(record({ period: HIST, paymentReference: 'M-1' })).rejects.toMatchObject({ code: 'CONFLICT' });
    expect(await Payment.countDocuments({})).toBe(0);
    expect(await RentCharge.countDocuments({})).toBe(0);
    const { payment } = await record({ period: HIST, paymentReference: 'M-2', tenancyId: String(overlap._id) });
    expect(String(payment.tenancyId)).toBe(String(overlap._id));
    expect(String(payment.tenantId)).toBe(String(tenantC._id));
    expect(await RentCharge.countDocuments({ tenancyId: tenancyA._id })).toBe(0);
  });

  test('explicit tenancy with a tenantId that is not its tenant is rejected and writes nothing', async () => {
    await expect(record({ period: HIST, tenancyId: String(tenancyA._id), tenantId: String(tenantB._id), paymentReference: 'T-1' }))
      .rejects.toMatchObject({ code: 'INVALID_REQUEST' });
    expect(await Payment.countDocuments({})).toBe(0);
    expect(await RentCharge.countDocuments({})).toBe(0);
  });

  test('Payment, RentCharge, PaymentAllocation and Ledger all carry the same tenancy', async () => {
    const { payment, allocations } = await record({ period: HIST, amountCents: 300000, paymentReference: 'K-1' });
    const id = String(tenancyA._id);
    expect(String(payment.tenancyId)).toBe(id);
    const stored = await Payment.findById(payment._id).lean();
    expect(String(stored.tenancyId)).toBe(id);
    const allocs = await PaymentAllocation.find({ paymentId: payment._id }).lean();
    expect(allocs.length).toBeGreaterThan(0);
    expect(allocations.length).toBe(allocs.length);
    expect(allocs.every((a) => String(a.tenancyId) === id)).toBe(true);
    const charges = await RentCharge.find({ _id: { $in: allocs.map((a) => a.rentChargeId) } }).lean();
    expect(charges.every((c) => String(c.tenancyId) === id)).toBe(true);
    const ledger = await Ledger.find({ referenceType: 'Payment', referenceId: payment._id }).lean();
    expect(ledger).toHaveLength(1);
    expect(String(ledger[0].tenancyId)).toBe(id);
    expect(ledger[0].amountCents).toBe(300000);
    expect(allocs.reduce((n, a) => n + a.amountCents, 0)).toBeLessThanOrEqual(300000);
    // Nothing leaked onto the current tenancy.
    expect(await PaymentAllocation.countDocuments({ tenancyId: tenancyB._id })).toBe(0);
    expect(await Ledger.countDocuments({ tenancyId: tenancyB._id })).toBe(0);
  });

  test('overpayment is kept: full amount on the ledger, remainder reported as unapplied', async () => {
    const res = await record({ period: HIST, amountCents: 99999999, paymentReference: 'O-1' });
    expect(res.unappliedCents).toBeGreaterThan(0);
    const ledger = await Ledger.findOne({ referenceType: 'Payment', referenceId: res.payment._id }).lean();
    expect(ledger.amountCents).toBe(99999999);
  });

  test('a reference already used for another tenancy is never silently reused', async () => {
    const first = await record({ period: HIST, paymentReference: 'DUP-1' });
    await expect(record({ period: CUR, paymentReference: 'DUP-1' })).rejects.toMatchObject({ code: 'CONFLICT' });
    expect(await Payment.countDocuments({})).toBe(1);
    expect(String((await Payment.findOne({})).tenancyId)).toBe(String(tenancyA._id));
    // The aborted attempt must not have generated charges for the other tenancy.
    expect(await RentCharge.countDocuments({ tenancyId: tenancyB._id })).toBe(0);
    expect(first.reused).toBe(false);
  });

  test('ledger failure rolls back the payment, allocations, charge updates and generated charges', async () => {
    const original = ledgerService.postEntry.bind(ledgerService);
    const spy = jest.spyOn(ledgerService, 'postEntry').mockImplementation(async (payload, opts) => {
      if (payload.entryType === 'PAYMENT') throw new Error('simulated ledger failure');
      return original(payload, opts);
    });
    try {
      await expect(record({ period: HIST, paymentReference: 'RB-1' })).rejects.toThrow('simulated ledger failure');
    } finally {
      spy.mockRestore();
    }
    expect(await Payment.countDocuments({})).toBe(0);
    expect(await PaymentAllocation.countDocuments({})).toBe(0);
    expect(await RentCharge.countDocuments({})).toBe(0);
    expect(await Ledger.countDocuments({})).toBe(0);
    // And a clean retry afterwards succeeds.
    const ok = await record({ period: HIST, paymentReference: 'RB-1' });
    expect(ok.reused).toBe(false);
  });
});
