// src/utils/mpesaIndexReadiness.js
//
// G5.3 — Read-only readiness plus explicit non-unique operational index provisioning.
// Unique indexes stay migration-controlled. autoIndex remains false on G5 schemas.
// Canonical receipt identity is never reported ready (B01/B02).

import mongoose from 'mongoose';
import { logger } from '../config/logger.js';

export const MPESA_COLLECTIONS = {
  merchant: 'mpesamerchantprofiles',
  inbox: 'mpesaingestionevents',
  transactions: 'mpesatransactions',
  checkpoints: 'mpesapullcheckpoints',
};

/** Non-unique indexes required for normal G5 operation. Never unique. */
export const REQUIRED_OPERATIONAL_INDEXES = [
  {
    collection: MPESA_COLLECTIONS.inbox,
    gate: 'durableInbox',
    name: 'idx_mpesa_inbox_processing',
    key: { state: 1, nextAttemptAt: 1, receivedAt: 1 },
    unique: false,
  },
  {
    collection: MPESA_COLLECTIONS.inbox,
    gate: 'durableInbox',
    name: 'idx_mpesa_inbox_merchant_channel',
    key: { merchantProfileId: 1, sourceChannel: 1, receivedAt: -1 },
    unique: false,
  },
  {
    collection: MPESA_COLLECTIONS.inbox,
    gate: 'durableInbox',
    name: 'idx_mpesa_inbox_digest_diag',
    key: { provider: 1, businessShortCode: 1, sourceChannel: 1, payloadDigest: 1 },
    unique: false,
  },
  {
    collection: MPESA_COLLECTIONS.merchant,
    gate: 'merchantOperationalQueries',
    name: 'idx_mpesa_merchant_operational',
    key: { clientId: 1, operationalState: 1 },
    unique: false,
  },
  {
    collection: MPESA_COLLECTIONS.transactions,
    gate: 'canonicalQueryIndexes',
    name: 'idx_mpesa_txn_verification',
    key: { verificationState: 1, transactionAt: -1 },
    unique: false,
  },
  {
    collection: MPESA_COLLECTIONS.transactions,
    gate: 'canonicalQueryIndexes',
    name: 'idx_mpesa_txn_client_time',
    key: { clientId: 1, transactionAt: -1 },
    unique: false,
  },
];

export const MERCHANT_UNIQUE_INDEX = {
  collection: MPESA_COLLECTIONS.merchant,
  name: 'uniq_client_business_shortcode',
  key: { clientId: 1, businessShortCode: 1 },
  unique: true,
};

export const CHECKPOINT_UNIQUE_INDEX = {
  collection: MPESA_COLLECTIONS.checkpoints,
  name: 'uniq_mpesa_pull_checkpoint_profile',
  key: { merchantProfileId: 1 },
  unique: true,
};

/**
 * Source-observation idempotency (inbox). Partial on string keys so legacy rows without a key
 * do not block creation. This is NOT canonical receipt identity (B01/B02 unresolved).
 * Created only by the guarded migration 20261114_g5_inbox_idempotency_index.js.
 */
export const INBOX_IDEMPOTENCY_INDEX = {
  collection: MPESA_COLLECTIONS.inbox,
  name: 'uniq_mpesa_inbox_idempotency',
  key: { idempotencyKey: 1 },
  unique: true,
  partialFilterExpression: { idempotencyKey: { $type: 'string' } },
};

export function indexMatches(indexes, spec) {
  if (!Array.isArray(indexes)) return false;
  return indexes.some((idx) => {
    if (!idx?.key) return false;
    const keyOk = JSON.stringify(idx.key) === JSON.stringify(spec.key);
    const uniqueOk = Boolean(idx.unique) === Boolean(spec.unique);
    const nameOk = spec.name == null || idx.name === spec.name;
    // A partial/non-partial mismatch changes uniqueness semantics, so compare filters exactly.
    const partialOk = JSON.stringify(idx.partialFilterExpression ?? null)
      === JSON.stringify(spec.partialFilterExpression ?? null);
    return keyOk && uniqueOk && nameOk && partialOk;
  });
}

let lastReport = null;

export function getMpesaIndexReport() {
  return lastReport;
}

function emptyGates() {
  return {
    durableInbox: false,
    merchantOperationalQueries: false,
    merchantRegistration: false,
    canonicalQueryIndexes: false,
    canonicalReceiptIdentity: false,
    inboxIdempotency: false,
    pullReconciliation: false,
  };
}

/**
 * Create declared non-unique operational indexes only.
 * Does not create unique merchant, checkpoint, or provisional receipt indexes.
 */
export async function provisionMpesaOperationalIndexes() {
  if (!mongoose.connection?.db) {
    return { created: [], skipped: true, reason: 'no_database_connection' };
  }
  const db = mongoose.connection.db;
  const created = [];
  for (const spec of REQUIRED_OPERATIONAL_INDEXES) {
    if (spec.unique) {
      throw new Error(`Refusing to auto-provision unique index ${spec.name}`);
    }
    const col = db.collection(spec.collection);
    const existing = await col.indexes().catch(() => []);
    if (indexMatches(existing, spec)) continue;
    await col.createIndex(spec.key, { name: spec.name, unique: false });
    created.push(spec.name);
  }
  return { created, skipped: false };
}

/**
 * Zero legacy rows that have enough data to derive a source-observation key
 * (sourceChannel + payloadDigest — the same two fields the migration's `deriveLegacyKey` / the
 * production `buildInboxIdempotencyKey` require) but still lack `idempotencyKey`. Any such row
 * means coverage is incomplete, whether from an interrupted migration or an index created without
 * running it. Fails closed (returns false) on any query error — never assume coverage.
 */
async function hasCompleteInboxBackfillCoverage(db) {
  try {
    const remaining = await db.collection(MPESA_COLLECTIONS.inbox).countDocuments({
      idempotencyKey: { $not: { $type: 'string' } },
      sourceChannel: { $type: 'string', $ne: '' },
      payloadDigest: { $type: 'string', $ne: '' },
    });
    return remaining === 0;
  } catch (err) {
    logger.debug({ err: err.message }, 'Could not verify inbox idempotency backfill coverage');
    return false;
  }
}

export async function inspectMpesaIndexes() {
  if (!mongoose.connection?.db) {
    lastReport = {
      ready: false,
      operationalReady: false,
      reason: 'no_database_connection',
      collections: {},
      gates: emptyGates(),
    };
    return lastReport;
  }

  const db = mongoose.connection.db;
  const report = {
    ready: false,
    operationalReady: false,
    reason: null,
    collections: {},
    gates: emptyGates(),
  };

  async function list(name) {
    try {
      return await db.collection(name).indexes();
    } catch (err) {
      return { error: err.message };
    }
  }

  report.collections[MPESA_COLLECTIONS.merchant] = await list(MPESA_COLLECTIONS.merchant);
  report.collections[MPESA_COLLECTIONS.inbox] = await list(MPESA_COLLECTIONS.inbox);
  report.collections[MPESA_COLLECTIONS.transactions] = await list(MPESA_COLLECTIONS.transactions);
  report.collections[MPESA_COLLECTIONS.checkpoints] = await list(MPESA_COLLECTIONS.checkpoints);

  const gateOk = (gate) => REQUIRED_OPERATIONAL_INDEXES
    .filter((spec) => spec.gate === gate)
    .every((spec) => indexMatches(report.collections[spec.collection], spec));

  report.gates.durableInbox = gateOk('durableInbox');
  report.gates.merchantOperationalQueries = gateOk('merchantOperationalQueries');
  report.gates.canonicalQueryIndexes = gateOk('canonicalQueryIndexes');
  report.gates.merchantRegistration = indexMatches(
    report.collections[MPESA_COLLECTIONS.merchant],
    MERCHANT_UNIQUE_INDEX,
  );
  report.gates.pullReconciliation = indexMatches(
    report.collections[MPESA_COLLECTIONS.checkpoints],
    CHECKPOINT_UNIQUE_INDEX,
  );
  // Structural check (the index exists) is necessary but not sufficient: a partial unique index
  // can exist while historical rows were only partly backfilled (e.g. a migration run that was
  // interrupted, or the index created by hand before the backfill finished). Readiness must prove
  // COMPLETE coverage — zero legacy rows that have enough data to derive a key but still lack one
  // — never just "the index object is present". Legacy rows that are permanently, legitimately
  // unkeyed (ambiguous/colliding historical duplicates the migration deliberately left alone) are
  // indistinguishable here from an incomplete run; both keep this gate false until a human
  // resolves them, by design (never silently choose between historical events).
  const indexStructurallyPresent = indexMatches(
    report.collections[MPESA_COLLECTIONS.inbox],
    INBOX_IDEMPOTENCY_INDEX,
  );
  report.gates.inboxIdempotency = indexStructurallyPresent
    && (await hasCompleteInboxBackfillCoverage(db));
  // B01/B02 unresolved. Never treat provisional receipt uniqueness as ready.
  report.gates.canonicalReceiptIdentity = false;

  report.operationalReady = report.gates.durableInbox && report.gates.merchantOperationalQueries;
  report.ready = report.gates.durableInbox;
  if (!report.ready) report.reason = 'mpesa_inbox_indexes_incomplete';

  lastReport = report;
  logger.debug({ gates: report.gates }, 'M-PESA index readiness inspected');
  return report;
}

/**
 * Fail-closed readiness probes. Both read verified index inspection only; no env flag can open them.
 * `inspect` is injectable for tests.
 */
export async function isInboxIdempotencyReady({ inspect = inspectMpesaIndexes } = {}) {
  const cached = getMpesaIndexReport();
  if (cached?.gates?.inboxIdempotency === true) return true;
  try {
    const report = await inspect();
    return report?.gates?.inboxIdempotency === true;
  } catch {
    return false;
  }
}

/** Canonical receipt identity is unresolved (B01/B02): always false until separately verified. */
export function isCanonicalReceiptIdentityReady() {
  return getMpesaIndexReport()?.gates?.canonicalReceiptIdentity === true;
}
