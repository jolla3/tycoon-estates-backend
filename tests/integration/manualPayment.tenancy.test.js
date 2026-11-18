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
import { paymentService } from '../../src/services/payment.service.js';

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
    await expect(record({ period: HIST, tenantId: String(tenantB._id), paymentReference: 'X-4' })).rejects.toBeDefined();
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
});
