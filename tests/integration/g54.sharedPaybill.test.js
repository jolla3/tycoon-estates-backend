/**
 * G5.4 shared PayBill — MongoDB REPLICA-SET integration tests.
 *
 * NOT EXECUTED: required service unavailable in this execution environment.
 * (No disposable MongoDB replica set was available to the session that authored these tests.)
 * Do not cite them as passing evidence until they have been run.
 *
 * Run locally against a disposable replica set (database name MUST match tycoon_test_*):
 *   TYCOON_ALLOW_DESTRUCTIVE_TEST_DB=1 \
 *   MONGODB_URI='mongodb://127.0.0.1:27017/tycoon_test_g54?replicaSet=rs0' \
 *   REDIS_URL='redis://127.0.0.1:6379' COOKIE_SECRET=x SESSION_SECRET=y \
 *   ENCRYPTION_KEY=$(printf 'a%.0s' $(seq 64)) BANK_SECRETS_ENCRYPTION_KEY=$(printf 'b%.0s' $(seq 64)) \
 *   npm test -- tests/integration/g54.sharedPaybill.test.js
 *
 * Scenario: ONE PayBill, THREE estates, THREE tenancies.
 */
import '../setup.js';
import { describeWithMongo, connectTestDb, clearTestDb, disconnectTestDb } from '../helpers/db.js';
import { prepareG3TestIndexes } from '../helpers/g3Indexes.js';
import { Client } from '../../src/models/Client.js';
import { Estate } from '../../src/models/Estate.js';
import { House } from '../../src/models/House.js';
import { Tenant } from '../../src/models/Tenant.js';
import { Tenancy } from '../../src/models/Tenancy.js';
import { MpesaMerchantProfile } from '../../src/models/MpesaMerchantProfile.js';
import { MpesaMerchantProfileEstate } from '../../src/models/MpesaMerchantProfileEstate.js';
import { MpesaCollectionReference } from '../../src/models/MpesaCollectionReference.js';
import { MpesaTransaction } from '../../src/models/MpesaTransaction.js';
import { MpesaIngestionEvent } from '../../src/models/MpesaIngestionEvent.js';
import { MERCHANT_UNIQUE_INDEX, PROFILE_ESTATE_UNIQUE_INDEX, REFERENCE_UNIQUE_INDEXES } from '../../src/utils/mpesaIndexReadiness.js';
import { platformMpesaProfileService } from '../../src/services/platformMpesaProfile.service.js';
import { mpesaReferenceService } from '../../src/services/mpesa/mpesaReference.service.js';
import { ingestNormalizedObservation } from '../../src/services/mpesa/mpesaIngestion.service.js';
import { normalizeC2bConfirmation } from '../../src/services/mpesa/mpesaNormalize.js';
import { mpesaTransactionService } from '../../src/services/mpesaTransaction.service.js';
import { tenancyService } from '../../src/services/tenancy.service.js';

const SHORTCODE = '600123';

const c2b = (over = {}) => normalizeC2bConfirmation({
  TransactionType: 'Pay Bill', TransID: `RX${Math.random().toString(36).slice(2, 10).toUpperCase()}`,
  TransTime: '20261110101500', TransAmount: '15000.00', BusinessShortCode: SHORTCODE, ...over,
});

describeWithMongo('G5.4 one PayBill, three estates, three tenancies', () => {
  let client; let estates; let tenancies; let profile; let refs; let actor;

  beforeAll(async () => {
    await connectTestDb();
    await clearTestDb();
    await prepareG3TestIndexes();
    // Migration-controlled unique indexes, installed explicitly in the disposable DB only.
    const mk = (Model, spec) => Model.collection.createIndex(spec.key, {
      name: spec.name, unique: true, ...(spec.partialFilterExpression ? { partialFilterExpression: spec.partialFilterExpression } : {}),
    });
    await mk(MpesaMerchantProfile, MERCHANT_UNIQUE_INDEX);
    await mk(MpesaMerchantProfileEstate, PROFILE_ESTATE_UNIQUE_INDEX);
    for (const s of REFERENCE_UNIQUE_INDEXES) await mk(MpesaCollectionReference, s);
    await Promise.all([MpesaTransaction, MpesaIngestionEvent].map((M) => M.createIndexes().catch(() => {})));
  });
  afterAll(async () => { await clearTestDb(); await disconnectTestDb(); });

  beforeEach(async () => {
    await Promise.all([Client, Estate, House, Tenant, Tenancy, MpesaMerchantProfile, MpesaMerchantProfileEstate,
      MpesaCollectionReference, MpesaTransaction, MpesaIngestionEvent].map((M) => M.deleteMany({})));
    client = await Client.create({ name: 'Shared PayBill Client' });
    actor = { _id: new (await import('mongoose')).default.Types.ObjectId() };
    estates = await Promise.all(['North', 'South', 'East'].map((name) => Estate.create({ clientId: client._id, name, isActive: true })));
    tenancies = [];
    for (const [i, estate] of estates.entries()) {
      const house = await House.create({ clientId: client._id, estateId: estate._id, houseNumber: `H${i}`, monthlyRent: 10000, status: 'occupied', isActive: true, dueDay: 5 });
      const tenant = await Tenant.create({ clientId: client._id, estateId: estate._id, houseId: house._id, name: `Tenant ${i}`, phone: `+25470000000${i}` });
      tenancies.push(await Tenancy.create({ clientId: client._id, estateId: estate._id, houseId: house._id, tenantId: tenant._id, startAt: new Date('2026-01-01T00:00:00+03:00'), status: 'ACTIVE' }));
    }
    profile = await platformMpesaProfileService.create(String(client._id), {
      merchantType: 'PAYBILL', businessShortCode: SHORTCODE, displayName: 'Shared PayBill', estateIds: estates.map((e) => String(e._id)),
    }, actor);
    await MpesaMerchantProfile.updateOne({ _id: profile.id }, { $set: { operationalState: 'ACTIVE' } }); // test-only
    refs = [];
    for (const t of tenancies) {
      refs.push((await mpesaReferenceService.issue({ clientId: client._id, merchantProfileId: profile.id, tenancyId: t._id, actor })).reference);
    }
  });

  test('profile maps all three estates and registers nothing', async () => {
    expect(profile.estates).toHaveLength(3);
    expect(profile).toMatchObject({ merchantType: 'PAYBILL', c2bRegistrationState: 'NONE', pullRegistrationState: 'NONE', callbackCapability: 'UNKNOWN' });
  });

  test('shortcode is globally owned: a second client cannot create the same shortcode', async () => {
    const other = await Client.create({ name: 'Other Client' });
    const oe = await Estate.create({ clientId: other._id, name: 'Other', isActive: true });
    await expect(platformMpesaProfileService.create(String(other._id), {
      merchantType: 'PAYBILL', businessShortCode: SHORTCODE, estateIds: [String(oe._id)],
    }, actor)).rejects.toMatchObject({ statusCode: 409 });
  });

  test('exact references allocate to exactly one estate each; no leakage between estates', async () => {
    const created = [];
    for (const [i, r] of refs.entries()) {
      const out = await ingestNormalizedObservation(c2b({ BillRefNumber: r.reference, TransAmount: `${(i + 1) * 100}.00` }));
      created.push(out.transaction);
    }
    for (const [i, txn] of created.entries()) {
      const row = await MpesaTransaction.findById(txn._id);
      expect(row.allocationState).toBe('ALLOCATED_BY_REFERENCE');
      expect(String(row.allocatedEstateId)).toBe(String(estates[i]._id));
      expect(String(row.allocatedTenantId)).toBe(String(tenancies[i].tenantId));
      expect(row.postingState).toBe('NOT_POSTED'); // allocation is routing, not posting
    }
    for (const [i, estate] of estates.entries()) {
      const page = await mpesaTransactionService.list(client._id, estate._id, {});
      expect(page.items.map((x) => x.receiptNumber)).toEqual([created[i].receiptNumber]);
    }
  });

  test('missing, malformed, unknown and retired references stay unallocated and are client-wide only', async () => {
    const cases = [undefined, 'HOUSE-1', 'T00000000Z', refs[0].reference];
    await MpesaCollectionReference.updateOne({ _id: refs[0]._id }, { $set: { status: 'RETIRED', retiredReason: 'ADMIN' } });
    for (const BillRefNumber of cases) await ingestNormalizedObservation(c2b({ BillRefNumber }));
    const rows = await MpesaTransaction.find({});
    expect(rows).toHaveLength(4);
    expect(rows.every((r) => r.allocationState === 'UNALLOCATED' && !r.allocatedEstateId)).toBe(true);
    for (const estate of estates) expect((await mpesaTransactionService.list(client._id, estate._id, {})).items).toHaveLength(0);
    expect((await mpesaTransactionService.list(client._id, null, {})).items).toHaveLength(4);
  });

  test('duplicate delivery of one receipt is idempotent', async () => {
    const obs = c2b({ BillRefNumber: refs[1].reference, TransID: 'RXDUPLICATE1' });
    await ingestNormalizedObservation(obs);
    await ingestNormalizedObservation({ ...obs, sourceChannel: 'PULL_QUERY' });
    expect(await MpesaTransaction.countDocuments({ receiptNumber: 'RXDUPLICATE1' })).toBe(1);
  });

  test('closing a tenancy retires its reference; the reference is never reassigned', async () => {
    await tenancyService.close(client._id, tenancies[2]._id, { reason: 'MOVE_OUT' });
    const retired = await MpesaCollectionReference.findById(refs[2]._id);
    expect(retired.status).toBe('RETIRED');
    expect(String(retired.tenantId)).toBe(String(tenancies[2].tenantId));
    const out = await ingestNormalizedObservation(c2b({ BillRefNumber: refs[2].reference }));
    const row = await MpesaTransaction.findById(out.transaction._id);
    expect(row.allocationState).toBe('UNALLOCATED');
    expect(row.allocationReason).toBe('reference_retired');
  });

  test('database rejects a second ACTIVE reference for the same tenancy and a duplicate reference', async () => {
    await expect(MpesaCollectionReference.create({
      merchantProfileId: profile.id, clientId: client._id, estateId: estates[0]._id, tenantId: tenancies[0].tenantId,
      tenancyId: tenancies[0]._id, reference: 'TZZZZZZZZZ', status: 'ACTIVE',
    })).rejects.toMatchObject({ code: 11000 });
    await expect(MpesaCollectionReference.create({
      merchantProfileId: profile.id, clientId: client._id, estateId: estates[0]._id, tenantId: tenancies[0].tenantId,
      tenancyId: tenancies[0]._id, reference: refs[1].reference, status: 'RETIRED',
    })).rejects.toMatchObject({ code: 11000 });
  });

  test('a Buy Goods receipt on a PayBill shortcode is quarantined, not coerced', async () => {
    const out = await ingestNormalizedObservation(c2b({ TransactionType: 'Buy Goods' }));
    expect(out.quarantined).toBe(true);
    expect(await MpesaTransaction.countDocuments({})).toBe(0);
  });
});
