// G3.2 explicit HouseType / immutable plan-version index readiness.
// These models use autoIndex:false. Indexes are installed only by the guarded
// G3.2 migration after legacy ownership and duplicate preflight.
import mongoose from 'mongoose';
import { Errors } from './errors.js';

const REQUIRED = {
  houseTypes: [
    {
      key: { clientId: 1, estateId: 1, name: 1 },
      unique: true,
      collation: { locale: 'en', strength: 2 },
      label: 'estate-scoped case-insensitive HouseType identity',
    },
  ],
  planVersions: [
    {
      key: { houseTypeId: 1, version: 1 },
      unique: true,
      label: 'unique HouseType plan version',
    },
    {
      key: { houseTypeId: 1, effectiveFromPeriod: 1 },
      unique: true,
      label: 'unique HouseType plan effective period',
    },
    {
      key: { clientId: 1, estateId: 1, houseTypeId: 1, effectiveFromPeriod: -1 },
      unique: false,
      label: 'HouseType plan period resolution',
    },
  ],
};

function sameKey(actual, expected) {
  const a = Object.entries(actual || {});
  const e = Object.entries(expected || {});
  return a.length === e.length && a.every(([key, value], index) =>
    key === e[index][0] && value === e[index][1]
  );
}

function sameCollation(actual, expected) {
  return actual?.locale === expected.locale && Number(actual?.strength) === expected.strength;
}

async function listIndexes(collectionName) {
  if (!mongoose.connection?.db) throw new Error('MongoDB connection is not established');
  try {
    return await mongoose.connection.db.collection(collectionName).listIndexes().toArray();
  } catch (error) {
    if (error?.code === 26 || error?.codeName === 'NamespaceNotFound') return [];
    throw error;
  }
}

function inspectGroup(indexes, requirements, needsCollation = false) {
  const results = requirements.map((required) => {
    const sameKeyIndexes = indexes.filter((index) => sameKey(index.key, required.key));
    const valid = sameKeyIndexes.some((index) =>
      (index.unique === true) === required.unique
      && (!needsCollation || sameCollation(index.collation, required.collation))
    );
    return {
      label: required.label,
      key: required.key,
      requiredUnique: required.unique,
      present: valid,
      conflictingDefinitions: sameKeyIndexes.filter((index) =>
        (index.unique === true) !== required.unique
        || (needsCollation && !sameCollation(index.collation, required.collation))
      ).map((index) => ({ name: index.name, unique: index.unique === true, collation: index.collation || null })),
    };
  });
  return results;
}

export async function inspectHouseTypeIndexes() {
  try {
    const [houseTypeIndexes, planVersionIndexes] = await Promise.all([
      listIndexes('housetypes'),
      listIndexes('housetypeplanversions'),
    ]);
    const houseType = inspectGroup(houseTypeIndexes, REQUIRED.houseTypes, true);
    const planVersions = inspectGroup(planVersionIndexes, REQUIRED.planVersions, false);
    const missing = [...houseType, ...planVersions].filter((item) => !item.present);
    const conflicts = [...houseType, ...planVersions].flatMap((item) => item.conflictingDefinitions);
    return {
      aligned: missing.length === 0 && conflicts.length === 0,
      reason: missing.length || conflicts.length
        ? `${missing.length} required index(es) missing; ${conflicts.length} conflicting definition(s)`
        : null,
      houseType,
      planVersions,
      missing: missing.map((item) => item.label),
      conflicts,
    };
  } catch (error) {
    return {
      aligned: false,
      reason: `HouseType index inspection failed: ${error.message}`,
      houseType: [],
      planVersions: [],
      missing: ['index inspection unavailable'],
      conflicts: [],
    };
  }
}

export async function assertHouseTypeIndexesAligned() {
  const report = await inspectHouseTypeIndexes();
  if (!report.aligned) {
    const error = Errors.ServiceUnavailable(`HouseType billing indexes are not ready: ${report.reason}`);
    error.code = 'HOUSETYPE_INDEXES_NOT_READY';
    error.report = report;
    throw error;
  }
  return report;
}
