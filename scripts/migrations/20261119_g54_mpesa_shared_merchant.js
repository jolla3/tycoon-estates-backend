/**
 * G5.4 — Shared merchant model migration.
 *
 *   1. READ-ONLY preflight inventory (always runs):
 *        - shortcode owners that collide across clients (never auto-merged)
 *        - Profile.clientId === Mapping.clientId === Estate.clientId (missing estates, cross-client
 *          estates, missing profiles, duplicate mapping/reference keys) — any violation blocks --execute
 *        - profiles with a legacy estateId but no mapping row (backfilled only when ALL checks pass)
 *        - canonical receipts per profile (identity is preserved, never rewritten)
 *   2. With --execute (allowlisted disposable/target DB only):
 *        - backfill one ACTIVE LEGACY_MIGRATION mapping per legacy profile.estateId (idempotent)
 *        - create unique indexes: uniq_provider_business_shortcode, uniq_mpesa_profile_estate,
 *          uniq_mpesa_ref_merchant_reference, uniq_mpesa_ref_active_tenancy
 *
 * Collisions BLOCK index creation: operators resolve ownership by hand first.
 * The legacy profile.estateId field and the old uniq_client_business_shortcode index are NOT
 * removed here. Remove them only through the explicit --drop-legacy-index step after
 * verification (see docs/superadmin/TYCOON_SUPERADMIN_CURRENT_BACKEND_MAP.md rollback notes).
 *
 * Rollback: the backfill only inserts rows with source=LEGACY_MIGRATION; delete exactly those
 * rows and drop the four new indexes to return to the previous behavior. profile.estateId was
 * never modified, so the old data remains intact.
 * Never run against production from automation. Dry-run is the default.
 */
import mongoose from 'mongoose';
import {
  parseMongoUri,
  assertSafeTarget,
  assertConnectedTarget,
  isInvokedDirectly,
} from './20261112_g53_mpesa_merchant_index.js';

export { parseMongoUri, assertSafeTarget, isInvokedDirectly };

const EXECUTE = process.argv.includes('--execute');
const DROP_LEGACY = process.argv.includes('--drop-legacy-index');

export const INDEX_SPECS = Object.freeze([
  { collection: 'mpesamerchantprofiles', name: 'uniq_provider_business_shortcode', key: { provider: 1, businessShortCode: 1 }, options: { unique: true } },
  { collection: 'mpesamerchantprofileestates', name: 'uniq_mpesa_profile_estate', key: { merchantProfileId: 1, estateId: 1 }, options: { unique: true } },
  { collection: 'mpesacollectionreferences', name: 'uniq_mpesa_ref_merchant_reference', key: { merchantProfileId: 1, reference: 1 }, options: { unique: true } },
  {
    collection: 'mpesacollectionreferences',
    name: 'uniq_mpesa_ref_active_tenancy',
    key: { merchantProfileId: 1, tenancyId: 1 },
    options: { unique: true, partialFilterExpression: { status: 'ACTIVE' } },
  },
]);

export function indexPresent(indexes, spec) {
  return (indexes || []).some((i) => i?.key
    && JSON.stringify(i.key) === JSON.stringify(spec.key)
    && i.name === spec.name
    && Boolean(i.unique) === Boolean(spec.options.unique)
    && JSON.stringify(i.partialFilterExpression || null) === JSON.stringify(spec.options.partialFilterExpression || null));
}

/**
 * Pure integrity analysis. Verifies, without guessing or repairing:
 *   MpesaMerchantProfile.clientId === MpesaMerchantProfileEstate.clientId === Estate.clientId
 * Inputs are plain arrays so the rules are unit-testable without a database.
 * Every violation carries a stable code and the offending ids for the operator.
 */
export function analyzeIntegrity({
  profiles = [], mappings = [], estates = [], collisions = [],
  mappingDuplicates = [], referenceDuplicates = [], activeTenancyDuplicates = [], references = [],
} = {}) {
  const profileById = new Map(profiles.map((p) => [String(p._id), p]));
  const estateById = new Map(estates.map((e) => [String(e._id), e]));
  const violations = [];
  const add = (code, detail) => violations.push({ code, ...detail });

  for (const c of collisions) {
    add('shortcode_collision', {
      provider: c._id?.provider, businessShortCode: c._id?.businessShortCode,
      profiles: c.n, clients: (c.clients || []).length,
    });
  }
  for (const d of mappingDuplicates) {
    add('duplicate_mapping_key', { merchantProfileId: String(d._id?.merchantProfileId), estateId: String(d._id?.estateId), count: d.n });
  }
  for (const d of referenceDuplicates) {
    add('duplicate_reference_key', { merchantProfileId: String(d._id?.merchantProfileId), reference: d._id?.reference, count: d.n });
  }
  for (const d of activeTenancyDuplicates) {
    add('duplicate_active_tenancy_reference', { merchantProfileId: String(d._id?.merchantProfileId), tenancyId: String(d._id?.tenancyId), count: d.n });
  }

  const checkEstate = (estateId, expectedClientId, ctx) => {
    const e = estateById.get(String(estateId));
    if (!e) { add('estate_missing', { ...ctx, estateId: String(estateId) }); return false; }
    if (String(e.clientId) !== String(expectedClientId)) {
      add('estate_client_mismatch', { ...ctx, estateId: String(estateId), estateClientId: String(e.clientId), expectedClientId: String(expectedClientId) });
      return false;
    }
    return true;
  };

  for (const m of mappings) {
    const ctx = { mappingId: String(m._id), merchantProfileId: String(m.merchantProfileId) };
    const p = profileById.get(String(m.merchantProfileId));
    if (!p) { add('mapping_profile_missing', ctx); continue; }
    if (String(p.clientId) !== String(m.clientId)) {
      add('mapping_client_mismatch', { ...ctx, mappingClientId: String(m.clientId), profileClientId: String(p.clientId) });
    }
    checkEstate(m.estateId, p.clientId, ctx);
  }

  const mappingKeys = new Set(mappings.map((m) => `${m.merchantProfileId}:${m.estateId}`));
  const backfill = [];
  for (const p of profiles) {
    if (!p.estateId) continue;
    const ctx = { merchantProfileId: String(p._id), legacy: true };
    const valid = checkEstate(p.estateId, p.clientId, ctx);
    if (valid && !mappingKeys.has(`${p._id}:${p.estateId}`)) backfill.push(p);
  }

  for (const r of references) {
    const p = profileById.get(String(r.merchantProfileId));
    const ctx = { referenceId: String(r._id), merchantProfileId: String(r.merchantProfileId) };
    if (!p) { add('reference_profile_missing', ctx); continue; }
    if (String(p.clientId) !== String(r.clientId)) add('reference_client_mismatch', ctx);
    else checkEstate(r.estateId, p.clientId, ctx);
  }

  return { violations, backfill, blocked: violations.length > 0 };
}

/** Pure: decide what a run would do from the analysis. Any violation blocks everything. */
export function buildPlan({ analysis, indexesBySpec, execute }) {
  const blocked = analysis.blocked;
  const codes = [...new Set(analysis.violations.map((v) => v.code))].sort();
  return {
    blocked,
    blockReason: blocked ? 'integrity_violations_require_manual_resolution' : null,
    violationCodes: codes,
    backfillMappings: blocked ? 0 : analysis.backfill.length,
    indexes: INDEX_SPECS.map((spec) => ({
      name: spec.name,
      state: indexesBySpec[spec.name]
        ? 'already_present'
        : (blocked ? 'blocked' : (execute ? 'will_create' : 'dry_run_would_create')),
    })),
  };
}

const CAP = 5000;

async function inventory(db) {
  const profiles = db.collection('mpesamerchantprofiles');
  const mappingsCol = db.collection('mpesamerchantprofileestates');
  const refsCol = db.collection('mpesacollectionreferences');

  const collisions = await profiles.aggregate([
    { $group: { _id: { provider: '$provider', businessShortCode: '$businessShortCode' }, n: { $sum: 1 }, clients: { $addToSet: '$clientId' } } },
    { $match: { n: { $gt: 1 } } }, { $limit: 100 },
  ]).toArray();
  const mappingDuplicates = await mappingsCol.aggregate([
    { $group: { _id: { merchantProfileId: '$merchantProfileId', estateId: '$estateId' }, n: { $sum: 1 } } },
    { $match: { n: { $gt: 1 } } }, { $limit: 100 },
  ]).toArray();
  const referenceDuplicates = await refsCol.aggregate([
    { $group: { _id: { merchantProfileId: '$merchantProfileId', reference: '$reference' }, n: { $sum: 1 } } },
    { $match: { n: { $gt: 1 } } }, { $limit: 100 },
  ]).toArray();
  const activeTenancyDuplicates = await refsCol.aggregate([
    { $match: { status: 'ACTIVE' } },
    { $group: { _id: { merchantProfileId: '$merchantProfileId', tenancyId: '$tenancyId' }, n: { $sum: 1 } } },
    { $match: { n: { $gt: 1 } } }, { $limit: 100 },
  ]).toArray();

  const profileRows = await profiles.find({}, { projection: { clientId: 1, estateId: 1 } }).toArray();
  const mappings = await mappingsCol.find({}, { projection: { merchantProfileId: 1, estateId: 1, clientId: 1 } }).toArray();
  const references = await refsCol.find({}, { projection: { merchantProfileId: 1, estateId: 1, clientId: 1 } }).toArray();

  const estateIds = new Map();
  for (const p of profileRows) if (p.estateId) estateIds.set(String(p.estateId), p.estateId);
  for (const m of mappings) estateIds.set(String(m.estateId), m.estateId);
  for (const r of references) estateIds.set(String(r.estateId), r.estateId);
  const ids = [...estateIds.values()];
  const estates = [];
  const estatesCol = db.collection('estates');
  for (let i = 0; i < ids.length; i += CAP) {
    estates.push(...await estatesCol.find({ _id: { $in: ids.slice(i, i + CAP) } }, { projection: { clientId: 1 } }).toArray());
  }

  const receiptCounts = await db.collection('mpesatransactions').aggregate([
    { $group: { _id: '$merchantProfileId', receipts: { $sum: 1 } } },
  ]).toArray();

  const analysis = analyzeIntegrity({
    profiles: profileRows, mappings, estates, collisions, mappingDuplicates,
    referenceDuplicates, activeTenancyDuplicates, references,
  });
  return { analysis, legacyProfileCount: profileRows.filter((p) => p.estateId).length, receiptProfiles: receiptCounts.length };
}

async function main() {
  const uri = process.env.MONGODB_URI;
  const expected = assertSafeTarget(uri, EXECUTE);
  console.log(JSON.stringify({ phase: 'preflight', dbName: expected.dbName, execute: EXECUTE }, null, 2));
  await mongoose.connect(uri);
  if (EXECUTE) assertConnectedTarget(mongoose.connection, expected);
  const db = mongoose.connection.db;

  const inv = await inventory(db);
  const indexesBySpec = {};
  for (const spec of INDEX_SPECS) {
    const present = await db.collection(spec.collection).indexes().catch(() => []);
    indexesBySpec[spec.name] = indexPresent(present, spec);
  }
  const plan = buildPlan({ analysis: inv.analysis, indexesBySpec, execute: EXECUTE });
  console.log(JSON.stringify({
    inventory: {
      legacyProfilesWithEstate: inv.legacyProfileCount,
      backfillCandidates: inv.analysis.backfill.length,
      integrityViolations: inv.analysis.violations.length,
      violations: inv.analysis.violations.slice(0, 100),
      profilesWithReceipts: inv.receiptProfiles,
    },
    plan,
  }, null, 2));

  if (plan.blocked) {
    // Never repair by guessing: any invalid relationship blocks --execute entirely.
    console.error(JSON.stringify({ error: plan.blockReason, codes: plan.violationCodes }));
    process.exitCode = 2;
    await mongoose.disconnect();
    return;
  }

  if (EXECUTE) {
    const mappings = db.collection('mpesamerchantprofileestates');
    // Indexes first so the idempotent backfill cannot create duplicates under concurrency.
    for (const spec of INDEX_SPECS) {
      if (!indexesBySpec[spec.name]) await db.collection(spec.collection).createIndex(spec.key, { name: spec.name, ...spec.options });
    }
    let inserted = 0;
    for (const p of inv.analysis.backfill) {
      const r = await mappings.updateOne(
        { merchantProfileId: p._id, estateId: p.estateId },
        { $setOnInsert: { clientId: p.clientId, status: 'ACTIVE', source: 'LEGACY_MIGRATION', createdByUserId: null, deactivatedAt: null, deactivatedByUserId: null, createdAt: new Date(), updatedAt: new Date() } },
        { upsert: true },
      );
      if (r.upsertedCount) inserted += 1;
    }
    if (DROP_LEGACY) {
      const idx = await db.collection('mpesamerchantprofiles').indexes();
      if (idx.some((i) => i.name === 'uniq_client_business_shortcode')) {
        await db.collection('mpesamerchantprofiles').dropIndex('uniq_client_business_shortcode');
      }
    }
    console.log(JSON.stringify({ status: 'executed', mappingsInserted: inserted, droppedLegacyIndex: DROP_LEGACY }, null, 2));
  }
  await mongoose.disconnect();
}

if (isInvokedDirectly(import.meta.url)) {
  main().catch((err) => { console.error(err); process.exitCode = 1; });
}
