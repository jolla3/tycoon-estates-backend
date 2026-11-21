/**
 * Exact-Tenancy deposit behaviour on a real replica set (guarded by
 * MONGODB_URI + TYCOON_ALLOW_DESTRUCTIVE_TEST_DB=1 and a tycoon_test_* DB).
 * Covers the scenarios the in-memory unit suite cannot: real transactions,
 * concurrency and idempotent retries.
 */
import mongoose from 'mongoose';
import { hasMongo, connectTestDb, clearTestDb, disconnectTestDb } from '../helpers/db.js';
import { prepareG3TestIndexes } from '../helpers/g3Indexes.js';
import { supportsMongoTransactions } from '../../src/config/database.js';
import { depositService } from '../../src/services/deposit.service.js';
import { Deposit } from '../../src/models/Deposit.js';
import { DepositMovement } from '../../src/models/DepositMovement.js';
import { Tenancy } from '../../src/models/Tenancy.js';
import { Tenant } from '../../src/models/Tenant.js';
import { House } from '../../src/models/House.js';
import { Estate } from '../../src/models/Estate.js';
import { Client } from '../../src/models/Client.js';

const describeMongo = hasMongo ? describe : describe.skip;
const actor = { _id: new mongoose.Types.ObjectId() };
let n = 0;

async function world() {
  const sfx = `${Date.now()}-${n++}`;
  const client = await Client.create({ name: 'C', slug: `c-${sfx}`, status: 'ACTIVE' });
  const mkEstate = (code) => Estate.create({ clientId: client._id, name: code, code: `${code}${sfx.slice(-4)}` });
  const [estA, estB] = await Promise.all([mkEstate('A'), mkEstate('B')]);
  const mkHouse = (estate, no) => House.create({
    clientId: client._id, estateId: estate._id, houseNumber: no,
    monthlyRent: 0, billingSource: 'UNCONFIGURED', status: 'occupied',
  });
  const mkTenant = (estate, house, phoneTail) => Tenant.create({
    clientId: client._id, estateId: estate._id, houseId: house._id, name: 'T',
    phone: `+2547${String(Date.now() + phoneTail).slice(-8)}`, status: 'active',
  });
  const mkTenancy = (estate, house, tenant, status = 'ACTIVE', clientId = client._id) => Tenancy.create({
    clientId, estateId: estate._id, houseId: house._id, tenantId: tenant._id,
    startAt: new Date('2026-01-01'), status,
  });
  return { client, estA, estB, mkHouse, mkTenant, mkTenancy };
}

describeMongo('deposit exact-tenancy behaviour', () => {
  beforeAll(async () => {
    await connectTestDb();
    if (supportsMongoTransactions() !== true) throw new Error('Requires MongoDB transactions');
    await clearTestDb();
    await prepareG3TestIndexes();
    await Promise.all([Deposit.createIndexes(), DepositMovement.createIndexes()]);
  });
  afterAll(disconnectTestDb);

  test('single tenancy: legacy tenant-id request resolves it', async () => {
    const w = await world();
    const h = await w.mkHouse(w.estA, '1'); const t = await w.mkTenant(w.estA, h, 1);
    const ty = await w.mkTenancy(w.estA, h, t);
    const dep = await depositService.recordPayment(w.client._id, t._id, 500, actor, null, { idempotencyKey: `k-${Date.now()}-1a` });
    expect(String(dep.tenancyId)).toBe(String(ty._id));
  });

  test('multiple eligible tenancies (same estate): legacy request is a typed 409 and writes nothing; explicit tenancyId works', async () => {
    const w = await world();
    const h1 = await w.mkHouse(w.estA, '1'); const h2 = await w.mkHouse(w.estA, '2');
    const t = await w.mkTenant(w.estA, h1, 2);
    const ty1 = await w.mkTenancy(w.estA, h1, t); const ty2 = await w.mkTenancy(w.estA, h2, t);
    await expect(depositService.recordPayment(w.client._id, t._id, 500, actor, null, { idempotencyKey: `k-${Date.now()}-2a` }))
      .rejects.toMatchObject({ code: 'DEPOSIT_TENANCY_AMBIGUOUS', status: 409 });
    expect(await DepositMovement.countDocuments({ clientId: w.client._id })).toBe(0);
    const dep = await depositService.recordPayment(w.client._id, t._id, 500, actor, null, { idempotencyKey: `k-${Date.now()}-2b`, tenancyId: ty2._id });
    expect(String(dep.tenancyId)).toBe(String(ty2._id));
    expect(await Deposit.countDocuments({ tenancyId: ty1._id })).toBe(0);
  });

  test('different estates: estate scope and estateId disambiguate; wrong estate is not found', async () => {
    const w = await world();
    const hA = await w.mkHouse(w.estA, '1'); const hB = await w.mkHouse(w.estB, '1');
    const t = await w.mkTenant(w.estA, hA, 3);
    await w.mkTenancy(w.estA, hA, t); const tyB = await w.mkTenancy(w.estB, hB, t);
    const dep = await depositService.ensureRequired(w.client._id, { tenantId: t._id, requiredCents: 900 }, actor, w.estB._id);
    expect(String(dep.tenancyId)).toBe(String(tyB._id));
    await expect(depositService.ensureRequired(w.client._id, { tenantId: t._id, tenancyId: tyB._id, estateId: w.estA._id, requiredCents: 1 }, actor))
      .rejects.toMatchObject({ code: 'NOT_FOUND' });
  });

  test("other tenant's / other client's / missing / closed tenancy", async () => {
    const w = await world(); const o = await world();
    const h = await w.mkHouse(w.estA, '1'); const h2 = await w.mkHouse(w.estA, '2'); const h3 = await w.mkHouse(w.estA, '3');
    const t = await w.mkTenant(w.estA, h, 4); const t2 = await w.mkTenant(w.estA, h2, 5);
    await w.mkTenancy(w.estA, h, t);
    const other = await w.mkTenancy(w.estA, h2, t2);
    const closed = await w.mkTenancy(w.estA, h3, t, 'CLOSED');
    const oh = await o.mkHouse(o.estA, '1'); const ot = await o.mkTenant(o.estA, oh, 6);
    const foreign = await o.mkTenancy(o.estA, oh, ot);
    const run = (tenancyId) => depositService.ensureRequired(w.client._id, { tenantId: t._id, tenancyId, requiredCents: 1 }, actor);
    await expect(run(other._id)).rejects.toMatchObject({ code: 'NOT_FOUND' });
    await expect(run(foreign._id)).rejects.toMatchObject({ code: 'NOT_FOUND' });
    await expect(run(new mongoose.Types.ObjectId())).rejects.toMatchObject({ code: 'NOT_FOUND' });
    await expect(run(closed._id)).rejects.toMatchObject({ code: 'TENANCY_NOT_ELIGIBLE' });
  });

  test('concurrent payments with distinct keys all land once; same key replays once', async () => {
    const w = await world();
    const h = await w.mkHouse(w.estA, '1'); const t = await w.mkTenant(w.estA, h, 7);
    const ty = await w.mkTenancy(w.estA, h, t);
    await depositService.ensureRequired(w.client._id, { tenancyId: ty._id, requiredCents: 10000 }, actor);
    await Promise.all([1, 2, 3].map((i) => depositService.recordPayment(w.client._id, t._id, 100, actor, null, { idempotencyKey: `conc-${w.client._id}-${i}`, tenancyId: ty._id })));
    const same = `same-${w.client._id}`;
    await Promise.all([1, 2, 3].map(() => depositService.recordPayment(w.client._id, t._id, 100, actor, null, { idempotencyKey: same, tenancyId: ty._id }).catch(() => null)));
    const dep = await Deposit.findOne({ tenancyId: ty._id });
    expect(dep.paidCents).toBe(400);
    expect(await DepositMovement.countDocuments({ tenancyId: ty._id })).toBe(4);
  });

  test('requirement lock: 409 after payment, stored values unchanged, same value is a no-op', async () => {
    const w = await world();
    const h = await w.mkHouse(w.estA, '1'); const t = await w.mkTenant(w.estA, h, 8);
    const ty = await w.mkTenancy(w.estA, h, t);
    await depositService.ensureRequired(w.client._id, { tenancyId: ty._id, requiredCents: 10000 }, actor);
    await depositService.ensureRequired(w.client._id, { tenancyId: ty._id, requiredCents: 12000 }, actor); // before payment: allowed
    await depositService.recordPayment(w.client._id, t._id, 4000, actor, null, { idempotencyKey: `lock-${w.client._id}`, tenancyId: ty._id });
    await expect(depositService.ensureRequired(w.client._id, { tenancyId: ty._id, requiredCents: 20000 }, actor))
      .rejects.toMatchObject({ code: 'DEPOSIT_REQUIREMENT_LOCKED', status: 409 });
    await depositService.ensureRequired(w.client._id, { tenancyId: ty._id, requiredCents: 12000 }, actor);
    const dep = await Deposit.findOne({ tenancyId: ty._id });
    expect(dep.requiredCents).toBe(12000);
    expect(dep.paidCents).toBe(4000);
  });
});
