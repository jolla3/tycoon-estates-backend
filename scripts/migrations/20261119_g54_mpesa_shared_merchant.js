/**
 * G5.4 — Shared merchant model migration.
 *
 *   1. READ-ONLY preflight inventory (always runs):
 *        - shortcode owners that collide across clients (never auto-merged)
 *        - profiles with a legacy estateId but no mapping row
 *        - mapping rows whose estate/client disagree with the profile (never auto-fixed)
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

/** Pure: decide what a run would do from inventory facts. */
export function buildPlan({ collisions, unmappedLegacyProfiles, indexesBySpec, execute }) {
  const blocked = collisions.length > 0;
  return {
    blocked,
    blockReason: blocked ? 'shortcode_collisions_require_manual_resolution' : null,
    backfillMappings: blocked ? 0 : unmappedLegacyProfiles.length,
    indexes: INDEX_SPECS.map((spec) => ({
      name: spec.name,
      state: indexesBySpec[spec.name]
        ? 'already_present'
        : (blocked ? 'blocked' : (execute ? 'will_create' : 'dry_run_would_create')),
    })),
  };
}

async function inventory(db) {
  const profiles = db.collection('mpesamerchantprofiles');
  const mappings = db.collection('mpesamerchantprofileestates');
  const collisions = await profiles.aggregate([
    { $group: { _id: { provider: '$provider', businessShortCode: '$businessShortCode' }, n: { $sum: 1 }, clients: { $addToSet: '$clientId' }, profileIds: { $push: '$_id' } } },
    { $match: { n: { $gt: 1 } } },
    { $limit: 100 },
  ]).toArray();

  const legacy = await profiles.find({ estateId: { $ne: null } }, { projection: { _id: 1, clientId: 1, estateId: 1 } }).toArray();
  const existing = await mappings.find({}, { projection: { merchantProfileId: 1, estateId: 1, clientId: 1 } }).toArray();
  const have = new Set(existing.map((m) => `${m.merchantProfileId}:${m.estateId}`));
  const unmappedLegacyProfiles = legacy.filter((p) => !have.has(`${p._id}:${p.estateId}`));

  const profileClient = new Map((await profiles.find({}, { projection: { clientId: 1 } }).toArray()).map((p) => [String(p._id), String(p.clientId)]));
  const mappingClientMismatch = existing.filter((m) => profileClient.get(String(m.merchantProfileId)) !== String(m.clientId)).length;

  const receiptCounts = await db.collection('mpesatransactions').aggregate([
    { $group: { _id: '$merchantProfileId', receipts: { $sum: 1 } } },
  ]).toArray();

  return { collisions, legacyProfileCount: legacy.length, unmappedLegacyProfiles, mappingClientMismatch, receiptProfiles: receiptCounts.length };
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
  const plan = buildPlan({ collisions: inv.collisions, unmappedLegacyProfiles: inv.unmappedLegacyProfiles, indexesBySpec, execute: EXECUTE });
  console.log(JSON.stringify({
    inventory: {
      shortcodeCollisions: inv.collisions.length,
      collisionSamples: inv.collisions.slice(0, 20).map((c) => ({ provider: c._id.provider, businessShortCode: c._id.businessShortCode, profiles: c.n, clients: c.clients.length })),
      legacyProfilesWithEstate: inv.legacyProfileCount,
      legacyProfilesWithoutMapping: inv.unmappedLegacyProfiles.length,
      mappingRowsWithClientMismatch: inv.mappingClientMismatch,
      profilesWithReceipts: inv.receiptProfiles,
    },
    plan,
  }, null, 2));

  if (plan.blocked || inv.mappingClientMismatch > 0) {
    console.error(JSON.stringify({ error: plan.blockReason || 'mapping_client_mismatch_requires_manual_resolution' }));
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
    for (const p of inv.unmappedLegacyProfiles) {
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
