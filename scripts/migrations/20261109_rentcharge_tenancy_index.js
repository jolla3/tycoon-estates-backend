/**
 * G3.1 RentCharge tenancy identity index migration.
 *
 * Default: read-only dry run.
 * Mutation: --execute, with exact database AND MongoDB server-address allowlists.
 *
 * The only automatically removable historical index is the exact legacy
 * definition verified in the pre-G3 RentCharge schema.
 *
 * No tenancy attribution, charge updates, or other data writes occur here.
 */
import mongoose from 'mongoose';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  assessRentChargeIndexes,
  isExactTargetRentChargeIndex,
  isExactObsoleteHouseRentChargeIndex,
} from '../../src/utils/rentChargeIndexDefinitions.js';

const EXECUTE = process.argv.includes('--execute');
const TARGET_NAME = 'uniq_tenancy_period_charge_desc';

function normalizeAddress(value) {
  const address = String(value || '').trim().toLowerCase();
  if (!address) return '';

  if (address.startsWith('[')) {
    const close = address.indexOf(']');
    if (close < 0) throw new Error(`Invalid bracketed MongoDB address: ${value}`);
    return address.slice(close + 1).startsWith(':')
      ? address
      : `${address}:27017`;
  }

  return address.includes(':') ? address : `${address}:27017`;
}

export function parseMongoUri(uri) {
  if (typeof uri !== 'string' || !uri.trim()) {
    throw new Error('MONGODB_URI is required');
  }

  const match = uri.match(/^(mongodb(?:\+srv)?:\/\/)(.*)$/i);
  if (!match) throw new Error('MONGODB_URI must use mongodb:// or mongodb+srv://');

  const scheme = match[1].toLowerCase();
  const remainder = match[2];
  const authorityEnd = remainder.search(/[/?#]/);

  if (authorityEnd < 0) {
    throw new Error('MONGODB_URI must include a database name');
  }

  const authority = remainder.slice(0, authorityEnd);
  const pathAndQuery = remainder.slice(authorityEnd);
  const path = pathAndQuery.split(/[?#]/, 1)[0];
  const encodedDbName = path.replace(/^\/+/, '').split('/')[0];

  if (!authority || !encodedDbName) {
    throw new Error('MONGODB_URI must include server address(es) and a database name');
  }

  const seedAuthority = authority.slice(authority.lastIndexOf('@') + 1);
  const seeds = seedAuthority.split(',').map(normalizeAddress);

  if (!seeds.length || seeds.some((seed) => !seed)) {
    throw new Error('MONGODB_URI contains an invalid server address');
  }

  return {
    scheme,
    dbName: decodeURIComponent(encodedDbName),
    seeds,
  };
}

export function parseAllowlist() {
  return new Set(
    String(process.env.G3_SAFE_DB_ALLOWLIST || '')
      .split(',')
      .map((value) => value.trim())
      .filter(Boolean)
  );
}

export function parseSafeMongoAddresses() {
  return new Set(
    String(process.env.G3_SAFE_MONGO_ADDRESSES || '')
      .split(',')
      .map(normalizeAddress)
      .filter(Boolean)
  );
}

/**
 * Pre-connect checks. For --execute, only standard mongodb:// connections
 * are accepted, and every URI seed must be explicitly allowlisted.
 */
export function assertSafeTarget(uri, execute = EXECUTE) {
  const parsed = parseMongoUri(uri);
  const { dbName, seeds, scheme } = parsed;

  const unsafeSystemDb = /^(admin|local|config)$/i.test(dbName);
  const productionNameToken = /(?:^|[^a-z0-9])(?:prod(?:uction)?|live)(?:$|[^a-z0-9])/i;

  if (unsafeSystemDb || productionNameToken.test(dbName)) {
    throw new Error(`Refusing unsafe database name "${dbName}"`);
  }

  if (!execute) return parsed;

  if (scheme !== 'mongodb://') {
    throw new Error(
      'Refusing --execute for mongodb+srv://. Use a dedicated standard mongodb:// disposable replica-set URI.'
    );
  }

  const allowedDbs = parseAllowlist();
  const targetDb = String(process.env.G3_MIGRATION_TARGET_DB || '').trim();
  const allowedAddresses = parseSafeMongoAddresses();

  if (!targetDb || targetDb !== dbName || !allowedDbs.has(dbName)) {
    throw new Error(
      `Refusing --execute: database "${dbName}" must equal G3_MIGRATION_TARGET_DB `
      + 'and appear in G3_SAFE_DB_ALLOWLIST'
    );
  }

  if (!allowedAddresses.size) {
    throw new Error('G3_SAFE_MONGO_ADDRESSES is required for --execute');
  }

  const unapprovedSeeds = seeds.filter((address) => !allowedAddresses.has(address));
  if (unapprovedSeeds.length) {
    throw new Error(
      `Refusing --execute: URI seed address(es) not allowlisted: ${unapprovedSeeds.join(', ')}`
    );
  }

  return parsed;
}

/**
 * Post-connect verification. Replica-set members discovered by the driver
 * must also be explicitly allowlisted; checking only the URI seed is not enough.
 */
export function assertConnectedTarget(expected, connection = mongoose.connection) {
  if (!connection?.db) throw new Error('MongoDB connection is not established');

  if (connection.name !== expected.dbName) {
    throw new Error(
      `Connected database "${connection.name}" differs from expected "${expected.dbName}"`
    );
  }

  const allowed = parseSafeMongoAddresses();
  const client = connection.getClient?.();
  const serverMap = client?.topology?.description?.servers;
  let connectedAddresses = serverMap instanceof Map
    ? [...serverMap.keys()].map(normalizeAddress)
    : [];

  if (!connectedAddresses.length && connection.host) {
    const host = connection.host;
    const port = connection.port || 27017;
    connectedAddresses = [normalizeAddress(`${host}:${port}`)];
  }

  if (!connectedAddresses.length) {
    throw new Error('Could not verify connected MongoDB server addresses; refusing migration');
  }

  const unapproved = connectedAddresses.filter((address) => !allowed.has(address));
  if (unapproved.length) {
    throw new Error(
      `Refusing --execute: connected MongoDB member(s) not allowlisted: ${unapproved.join(', ')}`
    );
  }

  return connectedAddresses;
}

async function listIndexes(collection) {
  try {
    return await collection.listIndexes().toArray();
  } catch (error) {
    if (error?.codeName === 'NamespaceNotFound' || error?.code === 26) return [];
    throw error;
  }
}

/**
 * Duplicate groups use the same equality behavior as the target index:
 * missing and null descriptions are grouped together; '' remains distinct.
 */
async function inspectDuplicateIdentities(collection) {
  const [result] = await collection.aggregate([
    {
      $match: {
        $expr: { $eq: [{ $type: '$tenancyId' }, 'objectId'] },
      },
    },
    {
      $group: {
        _id: {
          tenancyId: '$tenancyId',
          period: '$period',
          chargeType: '$chargeType',
          description: { $ifNull: ['$description', null] },
        },
        count: { $sum: 1 },
        sampleId: { $first: '$_id' },
      },
    },
    { $match: { count: { $gt: 1 } } },
    {
      $facet: {
        summary: [{ $count: 'count' }],
        samples: [
          { $limit: 10 },
          { $project: { _id: 1, count: 1, sampleId: 1 } },
        ],
      },
    },
  ], { allowDiskUse: true }).toArray();

  return {
    groupCount: result?.summary?.[0]?.count || 0,
    samples: (result?.samples || []).map((group) => ({
      key: group._id,
      count: group.count,
      sampleId: String(group.sampleId),
    })),
  };
}

/** Classify malformed, non-null tenancy identity values without changing them. */
async function inspectMalformedTenancyIds(collection) {
  const rows = await collection.aggregate([
    {
      $project: {
        _id: 1,
        tenancyType: { $type: '$tenancyId' },
      },
    },
    {
      $match: {
        tenancyType: { $nin: ['objectId', 'null', 'missing'] },
      },
    },
    {
      $group: {
        _id: '$tenancyType',
        count: { $sum: 1 },
        sampleId: { $first: '$_id' },
      },
    },
    { $sort: { _id: 1 } },
  ]).toArray();

  return rows.map((row) => ({
    bsonType: row._id,
    count: row.count,
    sampleId: String(row.sampleId),
  }));
}

/**
 * Identity fields must have scalar BSON types compatible with the Mongoose
 * schema. Arrays could make the compound index multikey; other types can
 * create identities the application never writes.
 *
 * Legacy description null/missing is retained and treated as equivalent
 * to null for duplicate preflight. Empty string remains distinct.
 */
async function inspectMalformedIdentityFields(collection) {
  const rows = await collection.aggregate([
    {
      $project: {
        _id: 1,
        fields: [
          {
            name: 'period',
            bsonType: { $type: '$period' },
            valid: { $eq: [{ $type: '$period' }, 'string'] },
          },
          {
            name: 'chargeType',
            bsonType: { $type: '$chargeType' },
            valid: { $eq: [{ $type: '$chargeType' }, 'string'] },
          },
          {
            name: 'description',
            bsonType: { $type: '$description' },
            valid: {
              $in: [{ $type: '$description' }, ['string', 'null', 'missing']],
            },
          },
        ],
      },
    },
    { $unwind: '$fields' },
    { $match: { 'fields.valid': false } },
    {
      $group: {
        _id: {
          field: '$fields.name',
          bsonType: '$fields.bsonType',
        },
        count: { $sum: 1 },
        sampleId: { $first: '$_id' },
      },
    },
    { $sort: { '_id.field': 1, '_id.bsonType': 1 } },
  ]).toArray();

  return rows.map((row) => ({
    field: row._id.field,
    bsonType: row._id.bsonType,
    count: row.count,
    sampleId: String(row.sampleId),
  }));
}

async function buildPreflight(collection, indexes, { collectionExists = true } = {}) {
  if (!collectionExists) {
    const assessment = assessRentChargeIndexes(indexes);

    return {
      collectionExists: false,
      totalCount: 0,
      attributedCount: 0,
      legacyNullOrMissingCount: 0,
      malformedTenancyIds: [],
      malformedTenancyIdCount: 0,
      malformedIdentityFields: [],
      malformedIdentityFieldCount: 0,
      duplicateGroupCount: 0,
      duplicateSamples: [],
      hasExactTargetUnique: assessment.hasExactTarget,
      exactObsoleteHouseUniques: assessment.exactObsoleteIndexes.map((index) => ({
        name: index.name,
        key: index.key,
      })),
      targetConflicts: assessment.targetConflicts.map((index) => ({
        name: index.name,
        key: index.key,
        partialFilterExpression: index.partialFilterExpression || null,
      })),
      suspiciousHouseUniques: assessment.suspiciousHouseUniqueIndexes.map((index) => ({
        name: index.name,
        key: index.key,
        partialFilterExpression: index.partialFilterExpression || null,
      })),
      blockers: [],
      canExecute: true,
    };
  }

  const duplicates = await inspectDuplicateIdentities(collection);
  const malformedTenancyIds = await inspectMalformedTenancyIds(collection);
  const malformedIdentityFields = await inspectMalformedIdentityFields(collection);

  const [
    totalCount,
    attributedCount,
    legacyNullOrMissingCount,
  ] = await Promise.all([
    collection.countDocuments({}),
    collection.countDocuments({
      $expr: { $eq: [{ $type: '$tenancyId' }, 'objectId'] },
    }),
    collection.countDocuments({
      $or: [
        { tenancyId: null },
        { tenancyId: { $exists: false } },
      ],
    }),
  ]);

  const assessment = assessRentChargeIndexes(indexes);
  const blockers = [];

  if (duplicates.groupCount > 0) {
    blockers.push('duplicate_tenancy_scoped_identities');
  }
  if (malformedTenancyIds.length > 0) {
    blockers.push('malformed_non_null_tenancy_ids');
  }
  if (malformedIdentityFields.length > 0) {
    blockers.push('malformed_identity_field_types');
  }
  if (assessment.targetConflicts.length > 0) {
    blockers.push('target_index_definition_conflict');
  }
  if (assessment.suspiciousHouseUniqueIndexes.length > 0) {
    blockers.push('unrecognized_house_unique_index');
  }

  return {
    collectionExists: true,
    totalCount,
    attributedCount,
    legacyNullOrMissingCount,
    malformedTenancyIds,
    malformedTenancyIdCount: malformedTenancyIds.reduce((sum, row) => sum + row.count, 0),
    malformedIdentityFields,
    malformedIdentityFieldCount: malformedIdentityFields.reduce((sum, row) => sum + row.count, 0),
    duplicateGroupCount: duplicates.groupCount,
    duplicateSamples: duplicates.samples,
    hasExactTargetUnique: assessment.hasExactTarget,
    exactObsoleteHouseUniques: assessment.exactObsoleteIndexes.map((index) => ({
      name: index.name,
      key: index.key,
    })),
    targetConflicts: assessment.targetConflicts.map((index) => ({
      name: index.name,
      key: index.key,
      partialFilterExpression: index.partialFilterExpression || null,
    })),
    suspiciousHouseUniques: assessment.suspiciousHouseUniqueIndexes.map((index) => ({
      name: index.name,
      key: index.key,
      partialFilterExpression: index.partialFilterExpression || null,
    })),
    blockers,
    canExecute: blockers.length === 0,
  };
}

async function main() {
  const uri = process.env.MONGODB_URI;
  const expected = assertSafeTarget(uri);

  await mongoose.connect(uri, {
    autoIndex: false,
    autoCreate: false,
  });

  if (EXECUTE) {
    const connectedAddresses = assertConnectedTarget(expected);
    console.log(JSON.stringify({
      phase: 'target_verified',
      database: expected.dbName,
      connectedAddresses,
    }, null, 2));
  }

  const db = mongoose.connection.db;
  const collection = db.collection('rentcharges');
  const collectionExists = (await db
    .listCollections({ name: 'rentcharges' }, { nameOnly: true })
    .toArray()).length > 0;

  let indexes = collectionExists ? await listIndexes(collection) : [];
  let preflight = await buildPreflight(collection, indexes, { collectionExists });

  console.log(JSON.stringify({
    phase: 'preflight',
    dryRun: !EXECUTE,
    database: expected.dbName,
    indexes: indexes.map((index) => ({
      name: index.name,
      key: index.key,
      unique: Boolean(index.unique),
      partialFilterExpression: index.partialFilterExpression || null,
      sparse: Boolean(index.sparse),
      collation: index.collation || null,
      hidden: Boolean(index.hidden),
    })),
    ...preflight,
  }, null, 2));

  if (!preflight.canExecute) {
    console.error('PREFLIGHT BLOCKED: no index changes were made.');
    return 1;
  }

  if (!EXECUTE) {
    const alreadyAligned = preflight.hasExactTargetUnique
      && preflight.exactObsoleteHouseUniques.length === 0;

    console.log(JSON.stringify({
      phase: 'dry_run_complete',
      alreadyAligned,
      plannedActions: alreadyAligned
        ? []
        : [
            ...(preflight.hasExactTargetUnique ? [] : ['create_and_verify_target_unique_index']),
            ...(preflight.exactObsoleteHouseUniques.length
              ? ['drop_exact_verified_legacy_house_unique_index']
              : []),
          ],
      message: 'Read-only dry run complete. No writes or index changes occurred.',
    }, null, 2));

    return 0;
  }

  if (!preflight.hasExactTargetUnique) {
    console.log(JSON.stringify({
      phase: 'create_target_index',
      name: TARGET_NAME,
    }, null, 2));

    await collection.createIndex(
      { tenancyId: 1, period: 1, chargeType: 1, description: 1 },
      {
        unique: true,
        name: TARGET_NAME,
        partialFilterExpression: { tenancyId: { $type: 'objectId' } },
      }
    );
  }

  indexes = await listIndexes(collection);

  if (!indexes.some(isExactTargetRentChargeIndex)) {
    throw new Error(
      'Exact target unique index verification failed. Legacy index has NOT been dropped.'
    );
  }

  console.log(JSON.stringify({
    phase: 'verify_target',
    ok: true,
    name: TARGET_NAME,
  }, null, 2));

  const exactLegacyIndexes = indexes.filter(isExactObsoleteHouseRentChargeIndex);

  for (const index of exactLegacyIndexes) {
    console.log(JSON.stringify({
      phase: 'drop_verified_legacy_index',
      name: index.name,
    }, null, 2));

    await collection.dropIndex(index.name);
  }

  indexes = await listIndexes(collection);
  const finalAssessment = assessRentChargeIndexes(indexes);
  const final = {
    phase: 'complete',
    hasExactTargetUnique: indexes.some(isExactTargetRentChargeIndex),
    remainingExactLegacyIndexes: finalAssessment.exactObsoleteIndexes.map((i) => i.name),
    targetConflicts: finalAssessment.targetConflicts.map((i) => i.name),
    suspiciousHouseUniques: finalAssessment.suspiciousHouseUniqueIndexes.map((i) => i.name),
  };

  console.log(JSON.stringify(final, null, 2));

  if (
    !final.hasExactTargetUnique
    || final.remainingExactLegacyIndexes.length
    || final.targetConflicts.length
    || final.suspiciousHouseUniques.length
  ) {
    throw new Error('Migration ended in a non-aligned state. Financial posting must remain disabled.');
  }

  return 0;
}

const isMain = process.argv[1]
  && resolve(process.argv[1]) === fileURLToPath(import.meta.url);

if (isMain) {
  main()
    .then((code) => {
      process.exitCode = code;
    })
    .catch((error) => {
      console.error(`RentCharge index migration failed: ${error.message}`);
      process.exitCode = 1;
    })
    .finally(async () => {
      try {
        await mongoose.disconnect();
      } catch {
        // Preserve the original migration result.
      }
    });
}

export {
  buildPreflight,
  inspectDuplicateIdentities,
  inspectMalformedTenancyIds,
  inspectMalformedIdentityFields,
};
