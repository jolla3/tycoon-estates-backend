/**
 * G3.2 HouseType ownership + index migration.
 *
 * Default: read-only preflight. --execute applies only explicit Estate mappings,
 * creates/verifies the new indexes, then removes only the exact legacy index.
 * No House, Tenancy, RentCharge, Payment or Ledger data is rewritten.
 *
 * Mapping file format (JSON object):
 *   { "<legacyHouseTypeObjectId>": "<ownerApprovedEstateObjectId>" }
 * Existing estateId values may not be reassigned by this migration.
 *
 * Required safety environment:
 *   MONGODB_URI=mongodb://127.0.0.1:27017/tycoon_g3_test
 *   G3_SAFE_DB_ALLOWLIST=tycoon_g3_test
 *   G3_MIGRATION_TARGET_DB=tycoon_g3_test
 *   G3_SAFE_MONGO_ADDRESSES=127.0.0.1:27017
 *
 * Execute only against an isolated disposable replica set, after owner review:
 *   node scripts/migrations/20261109_g32_house_type_indexes.js --execute --mapping=/absolute/path/mapping.json
 */
import mongoose from 'mongoose';
import fs from 'node:fs/promises';
import path from 'node:path';

const EXECUTE = process.argv.includes('--execute');
const MAPPING_ARG = process.argv.find((arg) => arg.startsWith('--mapping='));
const MAPPING_PATH = MAPPING_ARG ? MAPPING_ARG.slice('--mapping='.length) : null;
const TARGET_INDEX = 'clientId_1_estateId_1_name_1';
const EXPECTED_COLLATION = { locale: 'en', strength: 2 };
const SAMPLE_LIMIT = 40;

function csvSet(value) {
  return new Set(String(value || '').split(',').map((item) => item.trim()).filter(Boolean));
}

function normalizeAddress(value) {
  const address = String(value || '').trim().toLowerCase();
  if (!address) return '';
  if (address.startsWith('[')) {
    const close = address.indexOf(']');
    if (close < 0) throw new Error(`Invalid bracketed MongoDB address: ${value}`);
    return address.slice(close + 1).startsWith(':') ? address : `${address}:27017`;
  }
  return address.includes(':') ? address : `${address}:27017`;
}

function parseMongoUri(uri) {
  if (typeof uri !== 'string' || !uri.trim()) throw new Error('MONGODB_URI is required');
  const match = uri.match(/^(mongodb(?:\+srv)?:\/\/)(.*)$/i);
  if (!match) throw new Error('MONGODB_URI must use mongodb:// or mongodb+srv://');
  const remainder = match[2];
  const boundary = remainder.search(/[/?#]/);
  if (boundary < 0) throw new Error('MONGODB_URI must include a database name');
  const authority = remainder.slice(0, boundary);
  const pathQuery = remainder.slice(boundary);
  const dbSegment = pathQuery.split(/[?#]/, 1)[0].replace(/^\/+/, '').split('/')[0];
  const seedAuthority = authority.slice(authority.lastIndexOf('@') + 1);
  const seeds = seedAuthority.split(',').map(normalizeAddress);
  if (!authority || !dbSegment || seeds.some((item) => !item)) {
    throw new Error('MONGODB_URI must include valid server address(es) and a database name');
  }
  return { scheme: match[1].toLowerCase(), dbName: decodeURIComponent(dbSegment), seeds };
}

function assertSafeUri(uri) {
  const parsed = parseMongoUri(uri);
  if (/^(admin|local|config)$/i.test(parsed.dbName)
    || /(?:^|[^a-z0-9])(?:prod(?:uction)?|live)(?:$|[^a-z0-9])/i.test(parsed.dbName)) {
    throw new Error(`Refusing unsafe database name: ${parsed.dbName}`);
  }
  const allowedDbs = csvSet(process.env.G3_SAFE_DB_ALLOWLIST);
  const targetDb = String(process.env.G3_MIGRATION_TARGET_DB || '').trim();
  const allowedAddresses = new Set([...csvSet(process.env.G3_SAFE_MONGO_ADDRESSES)].map(normalizeAddress));
  if (!targetDb || targetDb !== parsed.dbName || !allowedDbs.has(parsed.dbName)) {
    throw new Error('Database must exactly match G3_MIGRATION_TARGET_DB and G3_SAFE_DB_ALLOWLIST');
  }
  if (!allowedAddresses.size || parsed.seeds.some((seed) => !allowedAddresses.has(seed))) {
    throw new Error('Every MongoDB URI seed must be explicitly allowlisted in G3_SAFE_MONGO_ADDRESSES');
  }
  if (EXECUTE && parsed.scheme !== 'mongodb://') {
    throw new Error('Execute mode requires standard mongodb://, not mongodb+srv://');
  }
  return { ...parsed, allowedAddresses };
}

function sameKey(actual, expected) {
  const a = Object.entries(actual || {});
  const e = Object.entries(expected || {});
  return a.length === e.length && a.every(([key, value], index) => key === e[index][0] && value === e[index][1]);
}

function collateNames(types) {
  const collator = new Intl.Collator('en', { sensitivity: 'accent', usage: 'sort' });
  const buckets = new Map();
  for (const type of types) {
    const key = `${String(type.clientId)}::${String(type.estateId)}`;
    if (!buckets.has(key)) buckets.set(key, []);
    buckets.get(key).push(type);
  }
  const duplicates = [];
  for (const [scope, rows] of buckets) {
    rows.sort((a, b) => collator.compare(String(a.name || ''), String(b.name || '')));
    for (let i = 1; i < rows.length; i += 1) {
      if (collator.compare(String(rows[i - 1].name || ''), String(rows[i].name || '')) === 0) {
        duplicates.push({ scope, houseTypeIds: [String(rows[i - 1]._id), String(rows[i]._id)], names: [rows[i - 1].name, rows[i].name] });
      }
    }
  }
  return duplicates;
}

function pushSample(list, item) {
  if (list.length < SAMPLE_LIMIT) list.push(item);
}

async function readMapping() {
  if (!MAPPING_PATH) return {};
  const raw = JSON.parse(await fs.readFile(path.resolve(MAPPING_PATH), 'utf8'));
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error('Mapping file must contain a JSON object of HouseType ID to Estate ID');
  return raw;
}

async function listIndexes(db, collectionName) {
  try {
    return await db.collection(collectionName).listIndexes().toArray();
  } catch (error) {
    if (error?.code === 26 || error?.codeName === 'NamespaceNotFound') return [];
    throw error;
  }
}

function checkIndex(indexes, key, { unique = false, collation = null } = {}) {
  const same = indexes.filter((index) => sameKey(index.key, key));
  const valid = same.some((index) => (index.unique === true) === unique
    && (!collation || (index.collation?.locale === collation.locale && Number(index.collation?.strength) === collation.strength)));
  const conflicts = same.filter((index) => (index.unique === true) !== unique
    || (collation && !(index.collation?.locale === collation.locale && Number(index.collation?.strength) === collation.strength)));
  return { present: valid, conflicts: conflicts.map((index) => ({ name: index.name, key: index.key, unique: index.unique === true, collation: index.collation || null })) };
}

async function assertConnectedTarget(expected, execute) {
  if (mongoose.connection.name !== expected.dbName) throw new Error('Connected database name does not match the allowlisted target');
  const topology = mongoose.connection.getClient()?.topology;
  const description = topology?.description;
  const members = description?.servers instanceof Map ? [...description.servers.keys()].map(normalizeAddress) : [];
  if (!members.length) throw new Error('Could not verify connected MongoDB topology members');
  const unapproved = members.filter((address) => !expected.allowedAddresses.has(address));
  if (unapproved.length) throw new Error(`Connected MongoDB members not allowlisted: ${unapproved.join(', ')}`);
  if (execute && !(description?.setName || description?.type === 'Sharded')) {
    throw new Error('Execute mode requires a verified replica set or sharded transaction-capable topology');
  }
}

async function main() {
  const uri = process.env.MONGODB_URI;
  const expected = assertSafeUri(uri);
  const mapping = await readMapping();
  await mongoose.connect(uri, { autoIndex: false, autoCreate: false });
  await assertConnectedTarget(expected, EXECUTE);

  const db = mongoose.connection.db;
  const [houseTypes, houses, estates, planVersions] = await Promise.all([
    db.collection('housetypes').find({}).toArray(),
    db.collection('houses').find({}).project({ _id: 1, clientId: 1, estateId: 1, houseTypeId: 1 }).toArray(),
    db.collection('estates').find({}).project({ _id: 1, clientId: 1 }).toArray(),
    db.collection('housetypeplanversions').find({}).toArray(),
  ]);

  const report = {
    mode: EXECUTE ? 'execute' : 'read_only_preflight',
    database: expected.dbName,
    counts: { houseTypes: houseTypes.length, houses: houses.length, estates: estates.length, planVersions: planVersions.length },
    missingEstateMappings: [],
    scopeConflicts: [],
    houseReferenceConflicts: [],
    nameCollisions: [],
    planVersionAnomalies: [],
    indexStatus: {},
    blockers: [],
    samplesPerSection: SAMPLE_LIMIT,
  };

  const estateById = new Map(estates.map((estate) => [String(estate._id), estate]));
  const typeById = new Map(houseTypes.map((type) => [String(type._id), type]));
  const mappedTypes = [];
  const knownMappingIds = new Set(houseTypes.map((type) => String(type._id)));

  for (const [typeId, estateId] of Object.entries(mapping)) {
    if (!mongoose.Types.ObjectId.isValid(typeId) || !mongoose.Types.ObjectId.isValid(String(estateId))) {
      pushSample(report.scopeConflicts, { houseTypeId: typeId, reason: 'mapping_contains_invalid_object_id' });
    } else if (!knownMappingIds.has(typeId)) {
      pushSample(report.scopeConflicts, { houseTypeId: typeId, reason: 'mapping_references_unknown_house_type' });
    }
  }

  for (const type of houseTypes) {
    const typeId = String(type._id);
    if (!mongoose.Types.ObjectId.isValid(String(type.clientId || '')) || !String(type.name || '').trim()) {
      pushSample(report.scopeConflicts, { houseTypeId: typeId, reason: 'missing_or_invalid_client_id_or_name' });
      continue;
    }
    const mappedEstateId = mapping[typeId] ? String(mapping[typeId]) : null;
    const existingEstateId = type.estateId ? String(type.estateId) : null;
    if (existingEstateId && mappedEstateId && existingEstateId !== mappedEstateId) {
      pushSample(report.scopeConflicts, { houseTypeId: typeId, reason: 'mapping_attempts_to_reassign_existing_estate', existingEstateId, mappedEstateId });
      continue;
    }
    const estateId = existingEstateId || mappedEstateId;
    if (!estateId) {
      pushSample(report.missingEstateMappings, { houseTypeId: typeId, clientId: String(type.clientId), name: type.name || null, reason: 'owner_approved_mapping_required' });
      continue;
    }
    const estate = estateById.get(estateId);
    if (!estate || String(estate.clientId) !== String(type.clientId)) {
      pushSample(report.scopeConflicts, { houseTypeId: typeId, reason: 'mapped_or_existing_estate_missing_or_wrong_client', estateId, clientId: String(type.clientId) });
      continue;
    }
    mappedTypes.push({ ...type, estateId: new mongoose.Types.ObjectId(estateId), _migrationWasMissingEstate: !existingEstateId });
  }

  const mappedTypeById = new Map(mappedTypes.map((type) => [String(type._id), type]));
  for (const house of houses) {
    if (!house.houseTypeId) continue;
    const type = mappedTypeById.get(String(house.houseTypeId));
    if (!type) {
      pushSample(report.houseReferenceConflicts, { houseId: String(house._id), houseTypeId: String(house.houseTypeId), reason: 'house_type_missing_or_unmapped' });
      continue;
    }
    if (String(type.clientId) !== String(house.clientId) || String(type.estateId) !== String(house.estateId)) {
      pushSample(report.houseReferenceConflicts, { houseId: String(house._id), houseTypeId: String(type._id), houseEstateId: String(house.estateId), typeEstateId: String(type.estateId), reason: 'house_and_type_scope_mismatch' });
    }
  }

  report.nameCollisions = collateNames(mappedTypes).slice(0, SAMPLE_LIMIT);

  const versionsByType = new Map();
  const seenVersion = new Set();
  const seenPeriod = new Set();
  for (const version of planVersions) {
    const type = mappedTypeById.get(String(version.houseTypeId));
    if (!type) {
      pushSample(report.planVersionAnomalies, { planVersionId: String(version._id), reason: 'orphan_or_unmapped_house_type' });
      continue;
    }
    if (String(version.clientId) !== String(type.clientId) || String(version.estateId) !== String(type.estateId)) {
      pushSample(report.planVersionAnomalies, { planVersionId: String(version._id), reason: 'plan_scope_mismatch' });
    }
    const versionKey = `${version.houseTypeId}:${version.version}`;
    const periodKey = `${version.houseTypeId}:${version.effectiveFromPeriod}`;
    if (seenVersion.has(versionKey)) pushSample(report.planVersionAnomalies, { houseTypeId: String(version.houseTypeId), reason: 'duplicate_version', version: version.version });
    if (seenPeriod.has(periodKey)) pushSample(report.planVersionAnomalies, { houseTypeId: String(version.houseTypeId), reason: 'duplicate_effective_period', effectiveFromPeriod: version.effectiveFromPeriod });
    seenVersion.add(versionKey);
    seenPeriod.add(periodKey);
    if (!Number.isSafeInteger(version.version) || version.version < 1 || !/^\d{4}-(0[1-9]|1[0-2])$/.test(String(version.effectiveFromPeriod || ''))) {
      pushSample(report.planVersionAnomalies, { planVersionId: String(version._id), reason: 'invalid_version_or_effective_period' });
    }
    const lines = Array.isArray(version.lines) ? version.lines : [];
    const lineIdentities = new Set();
    for (const line of lines) {
      const chargeType = String(line.chargeType || '').toUpperCase();
      const description = String(line.description || '').trim();
      const lineKey = `${chargeType}::${description.toLocaleLowerCase('en')}`;
      const dueDayInvalid = line.dueDay != null && (!Number.isInteger(line.dueDay) || line.dueDay < 1 || line.dueDay > 31);
      if (!line.lineId || !description || !['RENT', 'WATER', 'ELECTRICITY', 'OTHER'].includes(chargeType)
        || !Number.isSafeInteger(line.amountCents) || line.amountCents < 1 || dueDayInvalid || lineIdentities.has(lineKey)) {
        pushSample(report.planVersionAnomalies, { planVersionId: String(version._id), reason: 'invalid_or_duplicate_plan_line', lineId: line.lineId || null });
      }
      lineIdentities.add(lineKey);
    }
    if (!versionsByType.has(String(version.houseTypeId))) versionsByType.set(String(version.houseTypeId), []);
    versionsByType.get(String(version.houseTypeId)).push(version);
  }
  for (const [typeId, rows] of versionsByType) {
    rows.sort((a, b) => Number(a.version) - Number(b.version));
    for (let i = 0; i < rows.length; i += 1) {
      if (Number(rows[i].version) !== i + 1) {
        pushSample(report.planVersionAnomalies, { houseTypeId: typeId, reason: 'non_contiguous_plan_version_sequence', expectedVersion: i + 1, actualVersion: rows[i].version });
      }
      if (i > 0 && String(rows[i].effectiveFromPeriod) <= String(rows[i - 1].effectiveFromPeriod)) {
        pushSample(report.planVersionAnomalies, { houseTypeId: typeId, reason: 'effective_period_not_increasing_with_version', version: rows[i].version });
      }
    }
  }

  const [houseTypeIndexes, planVersionIndexes] = await Promise.all([
    listIndexes(db, 'housetypes'),
    listIndexes(db, 'housetypeplanversions'),
  ]);
  const targetName = checkIndex(houseTypeIndexes, { clientId: 1, estateId: 1, name: 1 }, { unique: true, collation: EXPECTED_COLLATION });
  const legacyName = houseTypeIndexes.filter((index) => sameKey(index.key, { clientId: 1, name: 1 }) && index.unique === true && !index.partialFilterExpression && !index.sparse && !index.collation);
  const versionUnique = checkIndex(planVersionIndexes, { houseTypeId: 1, version: 1 }, { unique: true });
  const periodUnique = checkIndex(planVersionIndexes, { houseTypeId: 1, effectiveFromPeriod: 1 }, { unique: true });
  const resolutionIndex = checkIndex(planVersionIndexes, { clientId: 1, estateId: 1, houseTypeId: 1, effectiveFromPeriod: -1 }, { unique: false });
  report.indexStatus = {
    houseTypeEstateUnique: targetName,
    exactLegacyClientNameUniqueIndexes: legacyName.map((index) => ({ name: index.name, key: index.key })),
    planVersionUnique: versionUnique,
    planEffectivePeriodUnique: periodUnique,
    planResolutionQuery: resolutionIndex,
  };

  if (report.missingEstateMappings.length) report.blockers.push('Every legacy HouseType without estateId requires an explicit owner-approved mapping.');
  if (report.scopeConflicts.length) report.blockers.push('HouseType Estate mapping, Estate ownership or mapping-file references are inconsistent.');
  if (report.houseReferenceConflicts.length) report.blockers.push('One or more Houses reference a missing, unmapped or cross-scope HouseType.');
  if (report.nameCollisions.length) report.blockers.push('Case-insensitive HouseType name collisions exist within a target Estate.');
  if (report.planVersionAnomalies.length) report.blockers.push('HouseType plan history contains orphaned, duplicate, out-of-order or invalid versions/lines.');
  if (targetName.conflicts.length || versionUnique.conflicts.length || periodUnique.conflicts.length || resolutionIndex.conflicts.length) {
    report.blockers.push('An index with a required key pattern exists with incompatible uniqueness or collation. Manual review required.');
  }
  report.summary = {
    mappedLegacyHouseTypes: mappedTypes.filter((type) => type._migrationWasMissingEstate).length,
    alreadyEstateScopedHouseTypes: mappedTypes.filter((type) => !type._migrationWasMissingEstate).length,
    missingEstateMappings: report.missingEstateMappings.length,
    scopeConflicts: report.scopeConflicts.length,
    houseReferenceConflicts: report.houseReferenceConflicts.length,
    nameCollisions: report.nameCollisions.length,
    planVersionAnomalies: report.planVersionAnomalies.length,
    blockers: report.blockers.length,
  };

  if (!EXECUTE) {
    console.log(JSON.stringify(report, null, 2));
    if (report.blockers.length) process.exitCode = 2;
    return;
  }

  if (!MAPPING_PATH && report.summary.mappedLegacyHouseTypes > 0) {
    throw new Error('Execute mode requires --mapping with explicit Estate ownership decisions');
  }
  if (report.blockers.length) {
    console.error(JSON.stringify(report, null, 2));
    throw new Error('Preflight blockers exist. No changes were made.');
  }

  const session = await mongoose.startSession();
  try {
    await session.withTransaction(async () => {
      for (const type of mappedTypes.filter((item) => item._migrationWasMissingEstate)) {
        const result = await db.collection('housetypes').updateOne(
          { _id: type._id, clientId: type.clientId, $or: [{ estateId: { $exists: false } }, { estateId: null }] },
          { $set: { estateId: type.estateId } },
          { session }
        );
        if (result.matchedCount !== 1) throw new Error(`HouseType ${type._id} changed during mapping; aborting.`);
      }
    });
  } finally {
    await session.endSession();
  }

  const ht = db.collection('housetypes');
  const pv = db.collection('housetypeplanversions');
  const ensureIndex = async (collection, indexes, key, options, checkOptions = {}) => {
    const current = checkIndex(indexes, key, checkOptions);
    if (!current.present) await collection.createIndex(key, options);
  };
  await ensureIndex(ht, houseTypeIndexes, { clientId: 1 }, { name: 'clientId_1' });
  await ensureIndex(ht, houseTypeIndexes, { estateId: 1 }, { name: 'estateId_1' });
  await ensureIndex(ht, houseTypeIndexes, { clientId: 1, estateId: 1, name: 1 }, {
    name: TARGET_INDEX, unique: true, collation: EXPECTED_COLLATION,
  }, { unique: true, collation: EXPECTED_COLLATION });
  await ensureIndex(pv, planVersionIndexes, { clientId: 1 }, { name: 'clientId_1' });
  await ensureIndex(pv, planVersionIndexes, { estateId: 1 }, { name: 'estateId_1' });
  await ensureIndex(pv, planVersionIndexes, { houseTypeId: 1 }, { name: 'houseTypeId_1' });
  await ensureIndex(pv, planVersionIndexes, { houseTypeId: 1, version: 1 }, {
    name: 'uniq_house_type_plan_version', unique: true,
  }, { unique: true });
  await ensureIndex(pv, planVersionIndexes, { houseTypeId: 1, effectiveFromPeriod: 1 }, {
    name: 'uniq_house_type_plan_effective_period', unique: true,
  }, { unique: true });
  await ensureIndex(pv, planVersionIndexes, { clientId: 1, estateId: 1, houseTypeId: 1, effectiveFromPeriod: -1 }, {
    name: 'clientId_1_estateId_1_houseTypeId_1_effectiveFromPeriod_-1',
  });

  const [htAfter, pvAfter] = await Promise.all([ht.listIndexes().toArray(), pv.listIndexes().toArray()]);
  const finalHt = checkIndex(htAfter, { clientId: 1, estateId: 1, name: 1 }, { unique: true, collation: EXPECTED_COLLATION });
  const finalVersion = checkIndex(pvAfter, { houseTypeId: 1, version: 1 }, { unique: true });
  const finalPeriod = checkIndex(pvAfter, { houseTypeId: 1, effectiveFromPeriod: 1 }, { unique: true });
  const finalResolution = checkIndex(pvAfter, { clientId: 1, estateId: 1, houseTypeId: 1, effectiveFromPeriod: -1 }, { unique: false });
  if (!finalHt.present || !finalVersion.present || !finalPeriod.present || !finalResolution.present) {
    throw new Error('New G3.2 indexes failed post-create verification. Legacy HouseType index was preserved.');
  }

  for (const legacy of legacyName) {
    await ht.dropIndex(legacy.name);
  }
  const oldStillPresent = (await ht.listIndexes().toArray()).some((index) =>
    sameKey(index.key, { clientId: 1, name: 1 }) && index.unique === true
  );
  if (oldStillPresent) throw new Error('An exact legacy HouseType unique index remains after migration.');

  console.log(JSON.stringify({
    ...report,
    mode: 'executed',
    result: 'G3.2 Estate-scoped HouseType and immutable plan-version indexes verified; exact legacy index removed only after verification.',
  }, null, 2));
}

main()
  .catch((error) => {
    console.error(`[G3.2 HouseType index migration] ${error.message}`);
    process.exitCode = 1;
  })
  .finally(async () => {
    if (mongoose.connection.readyState !== 0) await mongoose.disconnect();
  });
