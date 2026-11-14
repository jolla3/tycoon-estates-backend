/**
 * G5.3 — Partial unique index on mpesaingestionevents.idempotencyKey (source-observation identity).
 * NOT canonical receipt identity (B01/B02 unresolved); no MpesaTransaction index is touched.
 * Default dry-run; --execute is guarded by the shared G5 allowlist guard. Never run at app startup.
 *
 * Unlike a plain index-creation migration, historical events predate `idempotencyKey` and must be
 * backfilled *before* the unique index can be created, or every legacy row would violate it.
 * This module reuses the exact production `buildInboxIdempotencyKey()` — it must never contain a
 * second implementation that can drift from `mpesaIngestion.service.js`.
 *
 * Algorithm (read-only unless --execute):
 *  1. Scan existing `idempotencyKey` string values (projection only) into a Set; detect duplicates
 *     among them (should never happen; blocking if found — indicates earlier corruption).
 *  2. Scan every event still missing a key (projection: sourceChannel/businessShortCode/
 *     receiptNumber/payloadDigest only) and derive its key with the production algorithm.
 *     - Missing sourceChannel or payloadDigest ⇒ identity cannot be derived at all ⇒ blocker
 *       (`cannot_derive_identity`), never guessed.
 *     - Two or more legacy events deriving the SAME key ⇒ blocker (`legacy_key_collision`) —
 *       these are either genuine historical duplicates or ambiguous; never silently merged/chosen.
 *     - A derived key equal to an EXISTING key on some other event ⇒ blocker
 *       (`collides_with_existing_key`).
 *     - Everything else is eligible for backfill.
 *  3. Dry-run (default): report counts + bounded (20) samples per blocker category. Writes nothing.
 *  4. --execute: backfill ONLY eligible records with a conditional update
 *     (`{_id, idempotencyKey: null} -> {$set: idempotencyKey}`), so a concurrent write can never be
 *     clobbered and the run is safe to re-execute. Blocked records are never touched, deleted or
 *     merged — they stay unkeyed for manual resolution.
 *  5. After backfill, re-count remaining unkeyed-and-not-blocked records. If that count is not
 *     exactly zero, abort BEFORE creating the index (something did not backfill as expected).
 *  6. Only once coverage is verified complete does it create the single partial unique index.
 *     Legacy rows that remain unkeyed (because they were blockers) are invisible to a partial
 *     index on `{ idempotencyKey: { $type: 'string' } }`, so they do not need a key to be safe.
 *
 * A collection larger than G5_INBOX_MIGRATION_MAX_SCAN (default 200,000) aborts rather than
 * silently loading an unbounded number of documents into memory.
 */
import { assertSafeTarget, findExact } from './lib/g5MigrationGuard.js';
import { buildInboxIdempotencyKey } from '../../src/services/mpesa/mpesaIngestion.service.js';
import { INBOX_IDEMPOTENCY_INDEX as I } from '../../src/utils/mpesaIndexReadiness.js';

export const config = {
  title: 'g5_inbox_idempotency_index',
  creates: [{
    collection: I.collection,
    name: I.name,
    key: I.key,
    unique: true,
    partialFilterExpression: I.partialFilterExpression,
  }],
  drops: [],
};

const MAX_SCAN = parseInt(process.env.G5_INBOX_MIGRATION_MAX_SCAN || '200000', 10);
const SAMPLE_LIMIT = 20;

/** Derive this migration's key the exact same way production does. Returns null if underivable. */
export function deriveLegacyKey(doc) {
  if (!doc || typeof doc.sourceChannel !== 'string' || !doc.sourceChannel) return null;
  if (typeof doc.payloadDigest !== 'string' || !doc.payloadDigest) return null;
  return buildInboxIdempotencyKey({
    sourceChannel: doc.sourceChannel,
    businessShortCode: doc.businessShortCode ?? null,
    receiptNumber: doc.receiptNumber ?? null,
    payloadDigest: doc.payloadDigest,
  });
}

/**
 * Pure classification — no I/O. `legacyDocs`: [{ _id, sourceChannel, businessShortCode,
 * receiptNumber, payloadDigest }] for every event currently missing `idempotencyKey`.
 * `existingKeys`: Set<string> of idempotencyKey values already present on OTHER events.
 */
export function classifyLegacyDocs(legacyDocs, existingKeys = new Set()) {
  const byDerivedKey = new Map();
  const underivable = [];

  for (const doc of legacyDocs) {
    const key = deriveLegacyKey(doc);
    if (!key) {
      underivable.push({ _id: doc._id, reason: 'cannot_derive_identity' });
      continue;
    }
    if (!byDerivedKey.has(key)) byDerivedKey.set(key, []);
    byDerivedKey.get(key).push(doc._id);
  }

  const eligible = [];
  const legacyKeyCollisions = [];
  const existingKeyCollisions = [];

  for (const [key, ids] of byDerivedKey) {
    if (ids.length > 1) {
      legacyKeyCollisions.push({ key, ids: ids.slice(0, SAMPLE_LIMIT), count: ids.length });
      continue;
    }
    if (existingKeys.has(key)) {
      existingKeyCollisions.push({ _id: ids[0], key });
      continue;
    }
    eligible.push({ _id: ids[0], key });
  }

  const blockers = [
    ...underivable,
    ...legacyKeyCollisions.flatMap((c) => c.ids.map((_id) => ({ _id, reason: 'legacy_key_collision', key: c.key }))),
    ...existingKeyCollisions.map((c) => ({ ...c, reason: 'collides_with_existing_key' })),
  ];

  return {
    eligible,
    blockers,
    summary: {
      scanned: legacyDocs.length,
      eligible: eligible.length,
      underivable: underivable.length,
      legacyKeyCollisions: legacyKeyCollisions.length,
      existingKeyCollisions: existingKeyCollisions.length,
      legacyKeyCollisionSamples: legacyKeyCollisions.slice(0, SAMPLE_LIMIT),
      existingKeyCollisionSamples: existingKeyCollisions.slice(0, SAMPLE_LIMIT),
      underivableSamples: underivable.slice(0, SAMPLE_LIMIT),
    },
  };
}

/** Conditional, idempotent backfill ops — never unconditional, never a delete/merge. */
export function planBackfillOps(eligible) {
  return eligible.map(({ _id, key }) => ({
    updateOne: {
      filter: { _id, idempotencyKey: null },
      update: { $set: { idempotencyKey: key } },
    },
  }));
}

async function countAll(db, filter) {
  return db.collection(I.collection).countDocuments(filter);
}

async function scanExistingKeys(db) {
  const total = await countAll(db, { idempotencyKey: { $type: 'string' } });
  if (total > MAX_SCAN) {
    throw new Error(`refusing_unbounded_scan: ${total} keyed events exceeds G5_INBOX_MIGRATION_MAX_SCAN=${MAX_SCAN}`);
  }
  const keys = new Set();
  const dupGroupsCount = new Map();
  const cursor = db.collection(I.collection)
    .find({ idempotencyKey: { $type: 'string' } }, { projection: { idempotencyKey: 1 } });
  for await (const doc of cursor) {
    if (keys.has(doc.idempotencyKey)) {
      dupGroupsCount.set(doc.idempotencyKey, (dupGroupsCount.get(doc.idempotencyKey) || 1) + 1);
    }
    keys.add(doc.idempotencyKey);
  }
  const existingKeyDuplicates = [...dupGroupsCount.entries()]
    .slice(0, SAMPLE_LIMIT)
    .map(([key, count]) => ({ key, count }));
  return { keys, existingKeyDuplicates };
}

async function scanLegacyDocs(db) {
  const total = await countAll(db, { idempotencyKey: { $not: { $type: 'string' } } });
  if (total > MAX_SCAN) {
    throw new Error(`refusing_unbounded_scan: ${total} unkeyed events exceeds G5_INBOX_MIGRATION_MAX_SCAN=${MAX_SCAN}`);
  }
  const docs = [];
  const cursor = db.collection(I.collection).find(
    { idempotencyKey: { $not: { $type: 'string' } } },
    { projection: { sourceChannel: 1, businessShortCode: 1, receiptNumber: 1, payloadDigest: 1 } }
  );
  for await (const doc of cursor) docs.push(doc);
  return docs;
}

/** Read-only report: existing-key duplicates + legacy classification. Never writes. */
export async function runPreflight(db) {
  const { keys: existingKeys, existingKeyDuplicates } = await scanExistingKeys(db);
  const legacyDocs = await scanLegacyDocs(db);
  const { eligible, blockers, summary } = classifyLegacyDocs(legacyDocs, existingKeys);
  return {
    existingKeyDuplicates,
    eligible,
    blockers,
    summary: { ...summary, existingKeyDuplicateCount: existingKeyDuplicates.length },
    // Already-keyed events colliding with each other indicates prior corruption unrelated to
    // this historical backfill — hard-abort the whole run (nothing written, no index attempt).
    // Legacy (unkeyed) blockers are different: expected, historical, pre-dates the key, and
    // safely excluded from the partial index forever, so they never block backfill-of-the-rest
    // or index creation below (see `runMigration`).
    hardBlocked: existingKeyDuplicates.length > 0,
  };
}

export async function runMigration({ uri = process.env.MONGODB_URI, argv = process.argv, db: injectedDb } = {}) {
  const execute = argv.includes('--execute');
  if (!injectedDb) assertSafeTarget(uri, execute);
  let db = injectedDb;
  let mongooseRef = null;
  if (!db) {
    // Lazy import so unit tests never need a live mongoose connection.
    mongooseRef = (await import('mongoose')).default;
    await mongooseRef.connect(uri);
    db = mongooseRef.connection.db;
  }
  try {
    const report = await runPreflight(db);
    console.log(JSON.stringify({
      migration: config.title, phase: 'preflight', execute, summary: report.summary,
      blockerCount: report.blockers.length, hardBlocked: report.hardBlocked,
    }));
    if (report.blockers.length) {
      // Reported, never silently resolved. Blocked records are never backfilled, deleted or
      // merged; they remain unkeyed and invisible to the partial index. Does not abort the run.
      console.warn(JSON.stringify({ warning: 'legacy_identity_blockers_left_unresolved', blockerSamples: report.blockers.slice(0, SAMPLE_LIMIT) }));
    }

    if (report.hardBlocked) {
      console.error(JSON.stringify({ error: 'existing_key_duplicates_present', existingKeyDuplicates: report.existingKeyDuplicates }));
      process.exitCode = 2;
      return { status: 'blocked', report };
    }

    if (!execute) {
      console.log(JSON.stringify({
        status: 'dry_run',
        wouldBackfill: report.eligible.length,
        wouldLeaveUnkeyed: report.blockers.length,
        wouldCreateIndex: config.creates[0].name,
      }));
      return { status: 'dry_run', report };
    }

    const ops = planBackfillOps(report.eligible);
    if (ops.length) {
      const result = await db.collection(I.collection).bulkWrite(ops, { ordered: false });
      console.log(JSON.stringify({ phase: 'backfill', matched: result.matchedCount, modified: result.modifiedCount }));
    }

    // Verify complete eligible-record coverage before creating the unique index.
    const remainingUnkeyed = await countAll(db, { idempotencyKey: { $not: { $type: 'string' } } });
    const expectedRemaining = report.blockers.length; // blockers are intentionally left unkeyed
    if (remainingUnkeyed !== expectedRemaining) {
      console.error(JSON.stringify({
        error: 'backfill_coverage_incomplete',
        remainingUnkeyed,
        expectedRemaining,
      }));
      process.exitCode = 3;
      return { status: 'coverage_incomplete', remainingUnkeyed, expectedRemaining };
    }

    const existingIndexes = await db.collection(I.collection).indexes().catch(() => []);
    if (!findExact(existingIndexes, config.creates[0])) {
      const spec = config.creates[0];
      await db.collection(spec.collection).createIndex(spec.key, {
        name: spec.name,
        unique: true,
        partialFilterExpression: spec.partialFilterExpression,
      });
    }
    const verifyIndexes = await db.collection(I.collection).indexes();
    if (!findExact(verifyIndexes, config.creates[0])) {
      process.exitCode = 3;
      console.error(JSON.stringify({ error: 'post_verification_failed' }));
      return { status: 'verify_failed' };
    }
    console.log(JSON.stringify({ status: 'executed_verified', backfilled: ops.length }));
    return { status: 'executed_verified', backfilled: ops.length };
  } finally {
    if (mongooseRef) await mongooseRef.disconnect();
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  runMigration().catch((e) => { console.error(e.message); process.exitCode = 1; });
}
