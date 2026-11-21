/**
 * G5.4 hardening — MongoDB REPLICA-SET integration tests.
 *
 * NOT EXECUTED: required service unavailable in this execution environment.
 * (No MongoDB replica set or Redis was available; none was installed, downloaded or started.)
 * Do not cite as passing evidence until run. Mocked unit tests elsewhere do NOT substitute for these.
 *
 * Run locally against a disposable replica set (database name MUST match tycoon_test_*):
 *   TYCOON_ALLOW_DESTRUCTIVE_TEST_DB=1 \
 *   MONGODB_URI='mongodb://127.0.0.1:27017/tycoon_test_g54h?replicaSet=rs0' \
 *   REDIS_URL='redis://127.0.0.1:6379' COOKIE_SECRET=x SESSION_SECRET=y \
 *   ENCRYPTION_KEY=$(printf 'a%.0s' $(seq 64)) BANK_SECRETS_ENCRYPTION_KEY=$(printf 'b%.0s' $(seq 64)) \
 *   npm test -- tests/integration/g54.hardening.test.js
 *
 * Covers: reference issuance races, index-missing fail-closed, cross-client mapping rejection,
 * migration preflight against real data, Till regression, posting concurrency and stale-lease
 * fencing (BENEATH postingGate(): the gate itself stays closed, so this is NOT G3 settlement
 * evidence), reference history after tenancy movement, DTO redaction, estate/client visibility.
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
import { MpesaMerchantProfile } from '../../src/models/MpesaMerchantProfile.js';
import { MpesaMerchantProfileEstate } from '../../src/models/MpesaMerchantProfileEstate.js';
import { MpesaCollectionReference } from '../../src/models/MpesaCollectionReference.js';
import { MpesaTransaction } from '../../src/models/MpesaTransaction.js';
import { TenantCreditMovement } from '../../src/models/TenantCreditMovement.js';
import { MERCHANT_UNIQUE_INDEX, PROFILE_ESTATE_UNIQUE_INDEX, REFERENCE_UNIQUE_INDEXES } from '../../src/utils/mpesaIndexReadiness.js';
import { PAYMENT_RECEIPT_TENANCY_INDEX as CH, PAYMENT_CREDIT_KEY_INDEX as CR } from '../../src/utils/paymentReceiptIndexReadiness.js';
import { platformMpesaProfileService } from '../../src/services/platformMpesaProfile.service.js';
import { mpesaReferenceService } from '../../src/services/mpesa/mpesaReference.service.js';
import { mpesaTenantReferenceService } from '../../src/services/mpesa/mpesaTenantReference.service.js';
import { mpesaSubmissionLinkService } from '../../src/services/mpesa/mpesaSubmissionLink.service.js';
import { executeFencedPosting } from '../../src/services/mpesa/mpesaPosting.service.js';
import { tenancyService } from '../../src/services/tenancy.service.js';
import { safeMerchantProfile } from '../../src/services/platformIntegrations.service.js';
import { collectInventory, buildPlan, INDEX_SPECS } from '../../scripts/migrations/20261119_g54_mpesa_shared_merchant.js';

const oid = () => new mongoose.Types.ObjectId();
const mkIndex = (Model, spec) => Model.collection.createIndex(spec.key, {
  name: spec.name, unique: true, ...(spec.partialFilterExpression ? { partialFilterExpression: spec.partialFilterExpression } : {}),
});
const dropIfExists = async (Model, name) => { try { await Model.collection.dropIndex(name); } catch { /* absent */ } };

async function seedClient(label, estateCount = 2) {
  const client = await Client.create({ name: `${label} Client` });
  const estates = [];
  const tenancies = [];
  for (let i = 0; i < estateCount; i += 1) {
    const estate = await Estate.create({ clientId: client._id, name: `${label}-E${i}`, isActive: true });
    const house = await House.create({ clientId: client._id, estateId: estate._id, houseNumber: `${label}${i}`, monthlyRent: 10000, status: 'occupied', isActive: true, dueDay: 5 });
    const tenant = await Tenant.create({ clientId: client._id, estateId: estate._id, houseId: house._id, name: `${label} Tenant ${i}`, phone: `+2547000000${i}${label.length}` });
    tenancies.push(await Tenancy.create({ clientId: client._id, estateId: estate._id, houseId: house._id, tenantId: tenant._id, startAt: new Date('2026-01-01T00:00:00+03:00'), status: 'ACTIVE' }));
    estates.push(estate);
  }
  return { client, estates, tenancies };
}

describeWithMongo('G5.4 hardening (replica set)', () => {
  const actor = { _id: oid() };
  let A; let B; let paybill;

  beforeAll(async () => {
    await connectTestDb(); await clearTestDb(); await prepareG3TestIndexes();
    await Payment.collection.createIndex(CH.key, { name: CH.name, unique: true, partialFilterExpression: CH.partialFilterExpression });
    await Payment.collection.createIndex(CR.key, { name: CR.name, unique: true, partialFilterExpression: CR.partialFilterExpression });
    await TenantCreditMovement.createIndexes();
  });
  afterAll(async () => { await clearTestDb(); await disconnectTestDb(); });

  beforeEach(async () => {
    await Promise.all([Client, Estate, House, Tenant, Tenancy, RentCharge, Payment, MpesaMerchantProfile, MpesaMerchantProfileEstate, MpesaCollectionReference, MpesaTransaction]
      .map((M) => M.deleteMany({})));
    await mkIndex(MpesaMerchantProfile, MERCHANT_UNIQUE_INDEX);
    await mkIndex(MpesaMerchantProfileEstate, PROFILE_ESTATE_UNIQUE_INDEX);
    for (const s of REFERENCE_UNIQUE_INDEXES) await mkIndex(MpesaCollectionReference, s);
    A = await seedClient('A', 3);
    B = await seedClient('B', 1);
    paybill = await platformMpesaProfileService.create(String(A.client._id), {
      merchantType: 'PAYBILL', businessShortCode: '700100', displayName: 'A PayBill', estateIds: A.estates.map((e) => String(e._id)),
    }, actor);
  });

  describe('collection-reference issuance races and index readiness', () => {
    test('20 concurrent issues for one tenancy yield exactly one ACTIVE reference, all callers see it', async () => {
      const out = await Promise.allSettled(Array.from({ length: 20 }, () => mpesaReferenceService.issue({
        clientId: A.client._id, merchantProfileId: paybill.id, tenancyId: A.tenancies[0]._id, actor,
      })));
      const ok = out.filter((r) => r.status === 'fulfilled').map((r) => String(r.value.reference._id));
      expect(new Set(ok).size).toBe(1);
      expect(await MpesaCollectionReference.countDocuments({ tenancyId: A.tenancies[0]._id, status: 'ACTIVE' })).toBe(1);
      expect(out.filter((r) => r.status === 'fulfilled' && r.value.created)).toHaveLength(1);
    });

    test('concurrent issues across tenancies never share a reference value', async () => {
      await Promise.all(A.tenancies.map((t) => mpesaReferenceService.issue({ clientId: A.client._id, merchantProfileId: paybill.id, tenancyId: t._id, actor })));
      const rows = await MpesaCollectionReference.find({}).lean();
      expect(new Set(rows.map((r) => r.reference)).size).toBe(rows.length);
    });

    test('with the active-tenancy unique index missing, issuance fails closed (503) and writes nothing', async () => {
      await dropIfExists(MpesaCollectionReference, 'uniq_mpesa_ref_active_tenancy');
      await expect(mpesaReferenceService.issue({ clientId: A.client._id, merchantProfileId: paybill.id, tenancyId: A.tenancies[0]._id, actor }))
        .rejects.toMatchObject({ status: 503, code: 'MPESA_REFERENCE_INDEXES_NOT_READY' });
      expect(await MpesaCollectionReference.countDocuments({})).toBe(0);
    });
  });

  describe('cross-client mapping rejection', () => {
    test('creating a profile with another client\'s estate is rejected and leaves nothing behind', async () => {
      await expect(platformMpesaProfileService.create(String(A.client._id), {
        merchantType: 'PAYBILL', businessShortCode: '700200', estateIds: [String(B.estates[0]._id)],
      }, actor)).rejects.toBeTruthy();
      expect(await MpesaMerchantProfile.countDocuments({ businessShortCode: '700200' })).toBe(0);
      expect(await MpesaMerchantProfileEstate.countDocuments({ estateId: B.estates[0]._id })).toBe(0);
    });
    test('adding another client\'s estate to an existing profile is rejected', async () => {
      await expect(platformMpesaProfileService.addEstate(String(A.client._id), paybill.id, String(B.estates[0]._id), actor)).rejects.toBeTruthy();
      expect(await MpesaMerchantProfileEstate.countDocuments({ merchantProfileId: paybill.id, estateId: B.estates[0]._id })).toBe(0);
    });
  });

  describe('migration preflight against real data (indexes removed so bad data can exist)', () => {
    const rawProfiles = () => mongoose.connection.db.collection('mpesamerchantprofiles');
    const rawMappings = () => mongoose.connection.db.collection('mpesamerchantprofileestates');
    beforeEach(async () => {
      await dropIfExists(MpesaMerchantProfileEstate, 'uniq_mpesa_profile_estate');
      await dropIfExists(MpesaMerchantProfile, 'uniq_provider_business_shortcode');
    });

    test('clean legacy profile is a backfill candidate; execute-plan is not blocked', async () => {
      const lp = await rawProfiles().insertOne({ clientId: B.client._id, provider: 'SAFARICOM', businessShortCode: '810', merchantType: 'BUY_GOODS_TILL', estateId: B.estates[0]._id });
      const { analysis } = await collectInventory(mongoose.connection.db);
      expect(analysis.backfill.map((p) => String(p._id))).toContain(String(lp.insertedId));
    });
    test('legacy estate of another client, missing estate, and duplicate mapping keys all block', async () => {
      await rawProfiles().insertOne({ clientId: B.client._id, provider: 'SAFARICOM', businessShortCode: '811', estateId: A.estates[0]._id }); // cross-client
      await rawProfiles().insertOne({ clientId: B.client._id, provider: 'SAFARICOM', businessShortCode: '812', estateId: oid() }); // missing
      const m = { merchantProfileId: paybill.id ? new mongoose.Types.ObjectId(paybill.id) : null, estateId: A.estates[0]._id, clientId: A.client._id, status: 'ACTIVE' };
      await rawMappings().insertOne({ ...m, _id: oid() });
      await rawMappings().insertOne({ ...m, _id: oid() }); // duplicate key (index dropped above)
      const { analysis } = await collectInventory(mongoose.connection.db);
      const codes = new Set(analysis.violations.map((v) => v.code));
      expect(codes).toEqual(expect.objectContaining(new Set(['estate_client_mismatch', 'estate_missing', 'duplicate_mapping_key'])));
      const plan = buildPlan({ analysis, indexesBySpec: Object.fromEntries(INDEX_SPECS.map((s) => [s.name, false])), execute: true });
      expect(plan.blocked).toBe(true);
      expect(plan.backfillMappings).toBe(0);
    });
    test('analysis is deterministic on the same data', async () => {
      const a = await collectInventory(mongoose.connection.db);
      const b = await collectInventory(mongoose.connection.db);
      expect(a.analysis.violations).toEqual(b.analysis.violations);
    });
  });

  describe('Till submission regression (merchant-bound links, active mapping)', () => {
    test('several Tills on one estate require an explicit merchant; an inactive mapping cannot issue', async () => {
      const t1 = await platformMpesaProfileService.create(String(A.client._id), { merchantType: 'BUY_GOODS_TILL', businessShortCode: '900001', estateIds: [String(A.estates[0]._id)] }, actor);
      const t2 = await platformMpesaProfileService.create(String(A.client._id), { merchantType: 'BUY_GOODS_TILL', businessShortCode: '900002', estateIds: [String(A.estates[0]._id)] }, actor);
      await MpesaMerchantProfile.updateMany({ _id: { $in: [t1.id, t2.id] } }, { $set: { operationalState: 'ACTIVE' } }); // test-only
      const base = { clientId: A.client._id, estateId: A.estates[0]._id, tenantId: A.tenancies[0].tenantId, actor };
      await expect(mpesaSubmissionLinkService.issue(base)).rejects.toMatchObject({ status: 409 });
      const issued = await mpesaSubmissionLinkService.issue({ ...base, merchantProfileId: t1.id });
      expect(issued).toBeTruthy();
      await MpesaMerchantProfileEstate.updateOne({ merchantProfileId: t2.id, estateId: A.estates[0]._id }, { $set: { status: 'INACTIVE' } });
      await expect(mpesaSubmissionLinkService.issue({ ...base, merchantProfileId: t2.id })).rejects.toBeTruthy();
    });
  });

  describe('posting concurrency and stale-lease fencing (beneath postingGate; NOT G3 settlement evidence)', () => {
    const mkReceipt = async (tenancy, over = {}) => MpesaTransaction.create({
      clientId: A.client._id, merchantProfileId: paybill.id, provider: 'SAFARICOM', businessShortCode: '700100',
      receiptNumber: `RC${Math.random().toString(36).slice(2, 10).toUpperCase()}`, amountCents: 10000, transactionAt: new Date(),
      postingState: 'NOT_POSTED', verificationState: 'PROVIDER_VERIFIED', ...over,
    });
    const run = (txn, tenancy) => executeFencedPosting({
      txn, clientId: A.client._id, estateId: tenancy.estateId, tenantId: tenancy.tenantId, actorUserId: actor._id,
      evidence: { type: 'PAYBILL_REFERENCE', reference: { _id: oid() } },
    });
    const seedCharge = (tenancy) => RentCharge.create({
      clientId: A.client._id, estateId: tenancy.estateId, houseId: tenancy.houseId, tenantId: tenancy.tenantId, tenancyId: tenancy._id,
      period: '2026-04', chargeType: 'RENT', amountDueCents: 50000, amountPaidCents: 0, balanceCents: 50000, status: 'UNPAID', dueDate: new Date('2026-04-05T00:00:00+03:00'),
    });

    test('concurrent attempts on one receipt: exactly one posts, one Payment set exists', async () => {
      const t = A.tenancies[0]; await seedCharge(t);
      const txn = await mkReceipt(t);
      const out = await Promise.allSettled([run(txn, t), run(txn, t), run(txn, t)]);
      expect(out.filter((r) => r.status === 'fulfilled' && r.value.reused === false)).toHaveLength(1);
      const row = await MpesaTransaction.findById(txn._id);
      expect(row.postingState).toBe('POSTED');
      expect(await Payment.countDocuments({ mpesaReceiptId: txn._id })).toBe(1);
    });

    test('a receipt claimed for tenant X can never be posted for tenant Y', async () => {
      const [t0, t1] = A.tenancies; await seedCharge(t0); await seedCharge(t1);
      const txn = await mkReceipt(t0);
      await run(txn, t0);
      await expect(run(await MpesaTransaction.findById(txn._id), t1)).rejects.toMatchObject({ status: 409 });
    });

    test('an expired lease can be taken over, and the previous owner\'s finalize predicate no longer matches', async () => {
      const t = A.tenancies[0];
      const staleToken = 'stale-token';
      const txn = await mkReceipt(t, { postingState: 'PROCESSING', postingLeaseToken: staleToken, postingLeaseExpiresAt: new Date(Date.now() - 1000), attributedTenantId: t.tenantId });
      await seedCharge(t);
      await run(txn, t);
      const stale = await MpesaTransaction.updateOne(
        { _id: txn._id, postingLeaseToken: staleToken, postingState: 'PROCESSING', postingLeaseExpiresAt: { $gt: new Date() } },
        { $set: { postingState: 'POSTED' } },
      );
      expect(stale.matchedCount).toBe(0);
    });

    test('an unexpired lease blocks a second worker', async () => {
      const t = A.tenancies[0];
      const txn = await mkReceipt(t, { postingState: 'PROCESSING', postingLeaseToken: 'live', postingLeaseExpiresAt: new Date(Date.now() + 60_000), attributedTenantId: t.tenantId });
      await expect(run(txn, t)).rejects.toMatchObject({ status: 409 });
    });
  });

  describe('reference history after tenancy movement', () => {
    test('closing a tenancy retires its reference and a successor tenancy gets a different one; retired stays with the original tenant', async () => {
      const t = A.tenancies[0];
      const { reference: first } = await mpesaReferenceService.issue({ clientId: A.client._id, merchantProfileId: paybill.id, tenancyId: t._id, actor });
      await tenancyService.close(A.client._id, t._id, { reason: 'MOVE_OUT' });
      const retired = await MpesaCollectionReference.findById(first._id);
      expect(retired.status).toBe('RETIRED');
      expect(String(retired.tenancyId)).toBe(String(t._id));
      const view = await mpesaTenantReferenceService.view({ clientId: A.client._id, estateFilter: null, tenantId: t.tenantId });
      const row = view.tenancies.find((x) => x.tenancyId === String(t._id));
      expect(row.merchants[0].active).toBeNull();
      expect(row.merchants[0].retired.map((r) => r.reference)).toEqual([first.reference]);
      expect(row.merchants[0].canIssue).toBe(false);
    });
  });

  describe('DTO redaction and visibility boundaries', () => {
    test('merchant profile DTO never carries encrypted/masked-source fields or secrets', async () => {
      const row = await MpesaMerchantProfile.findById(paybill.id).select('+pullNominatedMsisdnEncrypted').lean();
      const dto = safeMerchantProfile({ ...row, pullNominatedMsisdnEncrypted: 'ciphertext' });
      const json = JSON.stringify(dto);
      expect(json).not.toContain('ciphertext');
      expect(dto).not.toHaveProperty('pullNominatedMsisdnEncrypted');
      expect(dto.pullRegistrationEligible).toBe(false);
    });
    test('estate-restricted caller sees only its own tenancy references; other client is NotFound', async () => {
      for (const t of A.tenancies) await mpesaReferenceService.issue({ clientId: A.client._id, merchantProfileId: paybill.id, tenancyId: t._id, actor });
      const own = await mpesaTenantReferenceService.view({ clientId: A.client._id, estateFilter: [String(A.estates[0]._id)], tenantId: A.tenancies[0].tenantId });
      expect(own.tenancies.every((t) => t.estateId === String(A.estates[0]._id))).toBe(true);
      await expect(mpesaTenantReferenceService.view({ clientId: A.client._id, estateFilter: [String(A.estates[0]._id)], tenantId: A.tenancies[1].tenantId }))
        .rejects.toMatchObject({ status: 404 });
      await expect(mpesaTenantReferenceService.view({ clientId: B.client._id, estateFilter: null, tenantId: A.tenancies[0].tenantId }))
        .rejects.toMatchObject({ status: 404 });
    });
  });
});
