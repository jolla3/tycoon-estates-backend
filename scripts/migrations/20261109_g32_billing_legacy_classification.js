/**
 * G3.2 legacy billing classification report.
 *
 * READ-ONLY BY DESIGN:
 * - Reads HouseTypes, Houses, HouseBillingConfigs, HouseTypePlanVersions,
 *   Estates and matching AuditLogs.
 * - Does not update documents, create indexes, run migrations, or infer
 *   historical tenancy attribution.
 * - --execute is explicitly rejected.
 *
 * Requires an explicit non-production database and server allowlist even
 * though this script performs reads only. It accepts mongodb:// only so
 * every replica-set member can be checked against the address allowlist.
 *
 * Required environment:
 *   MONGODB_URI
 *   G3_SAFE_DB_ALLOWLIST=tycoon_g3_test
 *   G3_MIGRATION_TARGET_DB=tycoon_g3_test
 *   G3_SAFE_MONGO_ADDRESSES=127.0.0.1:27017
 */
import { MongoClient } from 'mongodb';

const EXECUTE = process.argv.includes('--execute');
const SAMPLE_LIMIT = 40;
const READ_BATCH_SIZE = 500;
const REQUIRED_DB_NAME = String(process.env.G3_MIGRATION_TARGET_DB || '').trim();

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
  if (typeof uri !== 'string' || !uri.trim()) throw new Error('MONGODB_URI is required.');
  const match = uri.match(/^(mongodb:\/\/)(.*)$/i);
  if (!match) throw new Error('Read-only classifier accepts mongodb:// URIs only; SRV is not accepted.');
  const remainder = match[2];
  const authorityEnd = remainder.search(/[/?#]/);
  if (authorityEnd < 0) throw new Error('MONGODB_URI must include a database name.');
  const authority = remainder.slice(0, authorityEnd);
  const pathAndQuery = remainder.slice(authorityEnd);
  const path = pathAndQuery.split(/[?#]/, 1)[0];
  const dbName = decodeURIComponent(path.replace(/^\/+/, '').split('/')[0] || '');
  const seedAuthority = authority.slice(authority.lastIndexOf('@') + 1);
  const seeds = seedAuthority.split(',').map(normalizeAddress);
  if (!authority || !dbName || !seeds.length || seeds.some((seed) => !seed)) {
    throw new Error('MONGODB_URI must include valid server address(es) and a database name.');
  }
  return { dbName, seeds };
}

function csvSet(value) {
  return new Set(String(value || '').split(',').map((item) => item.trim()).filter(Boolean));
}

function assertSafeReadTarget(uri) {
  if (EXECUTE) throw new Error('This classifier is read-only; --execute is never supported.');
  const parsed = parseMongoUri(uri);
  const unsafeSystemDb = /^(admin|local|config)$/i.test(parsed.dbName);
  const productionNameToken = /(?:^|[^a-z0-9])(?:prod(?:uction)?|live)(?:$|[^a-z0-9])/i;
  if (unsafeSystemDb || productionNameToken.test(parsed.dbName)) {
    throw new Error(`Refusing unsafe database name "${parsed.dbName}".`);
  }
  const allowedDbs = csvSet(process.env.G3_SAFE_DB_ALLOWLIST);
  if (!REQUIRED_DB_NAME || REQUIRED_DB_NAME !== parsed.dbName || !allowedDbs.has(parsed.dbName)) {
    throw new Error(
      `Refusing connection: database "${parsed.dbName}" must equal G3_MIGRATION_TARGET_DB `
      + 'and appear in G3_SAFE_DB_ALLOWLIST.'
    );
  }
  const allowedAddresses = new Set(
    [...csvSet(process.env.G3_SAFE_MONGO_ADDRESSES)].map(normalizeAddress)
  );
  if (!allowedAddresses.size) throw new Error('G3_SAFE_MONGO_ADDRESSES is required.');
  const unapprovedSeeds = parsed.seeds.filter((seed) => !allowedAddresses.has(seed));
  if (unapprovedSeeds.length) {
    throw new Error(`Unapproved MongoDB URI seed(s): ${unapprovedSeeds.join(', ')}.`);
  }
  return { ...parsed, allowedAddresses };
}

function id(value) {
  return value == null ? '' : String(value);
}

function norm(value) {
  return String(value ?? '').normalize('NFKC').trim().toLocaleLowerCase('en');
}

function pushSample(target, value) {
  if (target.length < SAMPLE_LIMIT) target.push(value);
}

function bump(counter, key, amount = 1) {
  counter[key] = (counter[key] || 0) + amount;
}

async function readAll(db, collectionName, projection) {
  const collection = db.collection(collectionName);
  const rows = [];
  const cursor = collection.find({}, { projection }).batchSize(READ_BATCH_SIZE);
  for await (const row of cursor) rows.push(row);
  return rows;
}

function intervalOverlaps(a, b) {
  const aStart = a.effectiveFrom instanceof Date ? a.effectiveFrom.getTime() : new Date(a.effectiveFrom || 0).getTime();
  const bStart = b.effectiveFrom instanceof Date ? b.effectiveFrom.getTime() : new Date(b.effectiveFrom || 0).getTime();
  const aEnd = a.effectiveTo == null ? Number.POSITIVE_INFINITY : new Date(a.effectiveTo).getTime();
  const bEnd = b.effectiveTo == null ? Number.POSITIVE_INFINITY : new Date(b.effectiveTo).getTime();
  if (![aStart, bStart, aEnd, bEnd].every(Number.isFinite) && aEnd !== Number.POSITIVE_INFINITY && bEnd !== Number.POSITIVE_INFINITY) return false;
  return aStart < bEnd && bStart < aEnd;
}

function exactKey(key, expected) {
  const actualEntries = Object.entries(key || {});
  const expectedEntries = Object.entries(expected);
  return actualEntries.length === expectedEntries.length
    && expectedEntries.every(([field, direction], index) =>
      actualEntries[index]?.[0] === field && actualEntries[index]?.[1] === direction
    );
}

function expectedCaseInsensitiveCollation(collation) {
  return collation?.locale === 'en' && Number(collation?.strength) === 2;
}

function typeEstateStatus(type, linkedHouses, estateById) {
  const typeId = id(type._id);
  const clientId = id(type.clientId);
  const linkedEstateIds = [...new Set(linkedHouses.map((house) => id(house.estateId)).filter(Boolean))];
  const linkedClientIds = [...new Set(linkedHouses.map((house) => id(house.clientId)).filter(Boolean))];

  if (type.estateId) {
    const estateId = id(type.estateId);
    const estate = estateById.get(estateId);
    const foreignLinkedHouses = linkedHouses.filter((house) =>
      id(house.estateId) !== estateId || id(house.clientId) !== clientId
    );
    if (!estate || id(estate.clientId) !== clientId) {
      return { status: 'estate_reference_missing_or_wrong_client', proposedEstateId: null, linkedEstateIds, linkedClientIds, foreignHouseCount: foreignLinkedHouses.length };
    }
    if (foreignLinkedHouses.length) {
      return { status: 'existing_estate_conflicts_with_linked_houses', proposedEstateId: null, linkedEstateIds, linkedClientIds, foreignHouseCount: foreignLinkedHouses.length };
    }
    return { status: 'estate_scope_consistent', proposedEstateId: estateId, linkedEstateIds, linkedClientIds, foreignHouseCount: 0 };
  }

  if (linkedClientIds.some((value) => value !== clientId) || linkedClientIds.length > 1) {
    return { status: 'linked_house_client_conflict', proposedEstateId: null, linkedEstateIds, linkedClientIds, foreignHouseCount: linkedHouses.length };
  }
  if (linkedEstateIds.length > 1) {
    return { status: 'cross_estate_shared_type_requires_split_or_owner_decision', proposedEstateId: null, linkedEstateIds, linkedClientIds, foreignHouseCount: linkedHouses.length };
  }
  if (linkedEstateIds.length === 1 && linkedClientIds.length <= 1 && linkedClientIds[0] === clientId) {
    const candidateEstateId = linkedEstateIds[0];
    const estate = estateById.get(candidateEstateId);
    if (!estate || id(estate.clientId) !== clientId) {
      return { status: 'single_linked_estate_missing_or_wrong_client', proposedEstateId: null, linkedEstateIds, linkedClientIds, foreignHouseCount: linkedHouses.length };
    }
    return { status: 'single_linked_estate_candidate_requires_approval', proposedEstateId: candidateEstateId, linkedEstateIds, linkedClientIds, foreignHouseCount: 0 };
  }
  return { status: 'unreferenced_house_type_requires_owner_decision', proposedEstateId: null, linkedEstateIds, linkedClientIds, foreignHouseCount: 0 };
}

async function auditEvidenceForConfigs(db, configIds) {
  const evidenced = new Set();
  const auditCollection = db.collection('auditlogs');
  for (let offset = 0; offset < configIds.length; offset += 400) {
    const chunk = configIds.slice(offset, offset + 400);
    if (!chunk.length) continue;
    const cursor = auditCollection.find({
      action: 'BILLING_CONFIGURATION_CHANGED',
      resource: 'HouseBillingConfig',
      resourceId: { $in: chunk },
    }, { projection: { _id: 0, resourceId: 1 } }).batchSize(READ_BATCH_SIZE);
    for await (const row of cursor) if (row.resourceId) evidenced.add(String(row.resourceId));
  }
  return evidenced;
}

async function classify() {
  const uri = process.env.MONGODB_URI || process.env.MONGO_URI;
  const safety = assertSafeReadTarget(uri);
  const client = new MongoClient(uri, {
    serverSelectionTimeoutMS: 15000,
    connectTimeoutMS: 10000,
    retryReads: true,
    readPreference: 'secondaryPreferred',
  });

  try {
    await client.connect();
    const topologyServers = client.topology?.description?.servers;
    const connectedAddresses = topologyServers instanceof Map
      ? [...topologyServers.keys()].map(normalizeAddress)
      : [];
    if (!connectedAddresses.length) {
      throw new Error('Could not verify connected MongoDB replica-set/server addresses; refusing to inspect.');
    }
    const unapprovedConnected = connectedAddresses.filter((address) => !safety.allowedAddresses.has(address));
    if (unapprovedConnected.length) {
      throw new Error(`Connected MongoDB member(s) are not allowlisted: ${unapprovedConnected.join(', ')}.`);
    }

    const db = client.db(safety.dbName);
    const collections = new Set((await db.listCollections({}, { nameOnly: true }).toArray()).map((row) => row.name));
    const collectionNames = {
      estates: 'estates', houses: 'houses', houseTypes: 'housetypes',
      configs: 'housebillingconfigs', planVersions: 'housetypeplanversions', auditLogs: 'auditlogs',
    };
    const missingCollections = Object.entries(collectionNames)
      .filter(([, name]) => !collections.has(name)).map(([, name]) => name);

    const [estates, houses, houseTypes, configs, planVersions] = await Promise.all([
      readAll(db, collectionNames.estates, { _id: 1, clientId: 1 }),
      readAll(db, collectionNames.houses, {
        _id: 1, clientId: 1, estateId: 1, houseNumber: 1, houseTypeId: 1,
        billingSource: 1, monthlyRent: 1, dueDay: 1, createdAt: 1,
      }),
      readAll(db, collectionNames.houseTypes, {
        _id: 1, clientId: 1, estateId: 1, name: 1, defaultBilling: 1,
        defaultRentCents: 1, defaultDueDay: 1, planVersion: 1, createdAt: 1,
      }),
      readAll(db, collectionNames.configs, {
        _id: 1, clientId: 1, estateId: 1, houseId: 1, chargeType: 1,
        description: 1, amountCents: 1, isActive: 1, effectiveFrom: 1, effectiveTo: 1, createdAt: 1,
      }),
      readAll(db, collectionNames.planVersions, {
        _id: 1, clientId: 1, estateId: 1, houseTypeId: 1,
        version: 1, effectiveFromPeriod: 1, lines: 1, createdAt: 1,
      }),
    ]);

    const estateById = new Map(estates.map((row) => [id(row._id), row]));
    const houseById = new Map(houses.map((row) => [id(row._id), row]));
    const typeById = new Map(houseTypes.map((row) => [id(row._id), row]));
    const housesByType = new Map();
    const configsByHouse = new Map();
    const versionsByType = new Map();

    for (const house of houses) {
      if (!house.houseTypeId) continue;
      const key = id(house.houseTypeId);
      if (!housesByType.has(key)) housesByType.set(key, []);
      housesByType.get(key).push(house);
    }
    for (const config of configs) {
      const key = id(config.houseId);
      if (!configsByHouse.has(key)) configsByHouse.set(key, []);
      configsByHouse.get(key).push(config);
    }
    for (const version of planVersions) {
      const key = id(version.houseTypeId);
      if (!versionsByType.has(key)) versionsByType.set(key, []);
      versionsByType.get(key).push(version);
    }

    const configIds = configs.map((row) => id(row._id)).filter(Boolean);
    const auditEvidence = await auditEvidenceForConfigs(db, configIds);

    const report = {
      reportType: 'G3.2_BILLING_LEGACY_CLASSIFICATION',
      generatedAt: new Date().toISOString(),
      database: safety.dbName,
      connectedMongoAddresses: connectedAddresses,
      readOnly: true,
      collections: {
        missing: missingCollections,
        counts: {
          estates: estates.length, houses: houses.length, houseTypes: houseTypes.length,
          houseBillingConfigs: configs.length, houseTypePlanVersions: planVersions.length,
        },
      },
      summary: {
        houseTypesByEstateStatus: {},
        houseTypesByPlanStatus: {},
        houseBillingConfigsByStatus: {},
        housesByBillingSourceStatus: {},
        houseTypeNameCollisions: 0,
        orphanPlanVersions: 0,
        duplicateOrOverlappingConfigGroups: 0,
      },
      houseTypeEstateClassification: [],
      houseTypePlanClassification: [],
      houseTypeNameCollisions: [],
      planVersionAnomalies: [],
      houseBillingConfigClassification: [],
      overlappingBillingConfigGroups: [],
      houseBillingSourceClassification: [],
      houseTypeIndexes: [],
      migrationBlockers: [],
      warnings: [
        'No existing record was modified. No tenancy attribution was inferred or backfilled.',
        'A positive BILLING_CONFIGURATION_CHANGED audit match is evidence of an intentional UI change; absence of a match is ambiguous, not proof of an automatic copy.',
        'Current HouseType defaults and createdAt timestamps do not establish the historical effective month of a plan. Missing initial plan history requires an owner-approved effectiveFromPeriod.',
        'HouseType name-collision screening uses normalized JavaScript text comparison; MongoDB ICU collation remains authoritative when validating the unique index.',
        'A single linked Estate is only a candidate for missing HouseType estateId; it is not automatically assigned.',
      ],
    };

    const proposedEstateByType = new Map();
    for (const type of houseTypes) {
      const typeId = id(type._id);
      const estateStatus = typeEstateStatus(type, housesByType.get(typeId) || [], estateById);
      bump(report.summary.houseTypesByEstateStatus, estateStatus.status);
      if (estateStatus.proposedEstateId) proposedEstateByType.set(typeId, estateStatus.proposedEstateId);
      pushSample(report.houseTypeEstateClassification, {
        houseTypeId: typeId,
        clientId: id(type.clientId),
        name: type.name || null,
        linkedHouseCount: (housesByType.get(typeId) || []).length,
        ...estateStatus,
      });

      const versions = [...(versionsByType.get(typeId) || [])].sort((a, b) =>
        String(a.effectiveFromPeriod || '').localeCompare(String(b.effectiveFromPeriod || ''))
        || Number(a.version || 0) - Number(b.version || 0)
      );
      const status = versions.length ? 'plan_history_present' : 'missing_plan_history_requires_owner_effective_period';
      bump(report.summary.houseTypesByPlanStatus, status);
      const duplicatePeriods = versions.map((row) => row.effectiveFromPeriod).filter((period, index, all) => all.indexOf(period) !== index);
      const duplicateVersions = versions.map((row) => row.version).filter((version, index, all) => all.indexOf(version) !== index);
      const numericVersions = versions.map((row) => row.version).filter((version) => Number.isInteger(version) && version > 0).sort((a, b) => a - b);
      const versionGaps = [];
      if (numericVersions.length && numericVersions[0] !== 1) versionGaps.push([0, numericVersions[0]]);
      for (let index = 1; index < numericVersions.length; index += 1) {
        if (numericVersions[index] > numericVersions[index - 1] + 1) {
          versionGaps.push([numericVersions[index - 1], numericVersions[index]]);
        }
      }
      const effectiveOrderVersions = versions.map((row) => Number(row.version)).filter(Number.isInteger);
      const versionOrderMismatch = effectiveOrderVersions.some((value, index) =>
        index > 0 && value <= effectiveOrderVersions[index - 1]
      );
      const duplicateLineIdentities = [];
      for (const row of versions) {
        const seen = new Set();
        for (const line of row.lines || []) {
          const lineKey = `${String(line.chargeType || '').toUpperCase()}::${norm(line.description || '')}`;
          if (seen.has(lineKey)) duplicateLineIdentities.push({ version: row.version, lineIdentity: lineKey });
          seen.add(lineKey);
        }
      }
      const badVersions = versions.filter((row) =>
        !/^\d{4}-(0[1-9]|1[0-2])$/.test(String(row.effectiveFromPeriod || ''))
        || !Number.isInteger(row.version) || row.version < 1
        || !row.estateId
        || id(row.clientId) !== id(type.clientId)
        || (row.estateId && proposedEstateByType.get(typeId) && id(row.estateId) !== proposedEstateByType.get(typeId))
        || (row.lines || []).some((line) => !Number.isSafeInteger(line.amountCents) || line.amountCents < 1)
      );
      const latestVersion = numericVersions.length ? numericVersions[numericVersions.length - 1] : 0;
      const typeVersionMismatch = versions.length > 0 && Number(type.planVersion || 1) !== latestVersion;
      if (duplicatePeriods.length || duplicateVersions.length || badVersions.length || versionGaps.length
        || duplicateLineIdentities.length || versionOrderMismatch || typeVersionMismatch) {
        pushSample(report.planVersionAnomalies, {
          houseTypeId: typeId, duplicateEffectivePeriods: [...new Set(duplicatePeriods)],
          duplicateVersions: [...new Set(duplicateVersions)], versionGaps,
          versionOrderMismatch, typeVersionMismatch,
          currentHouseTypeVersion: Number(type.planVersion || 1), latestStoredVersion: latestVersion,
          duplicateLineIdentities, badVersionCount: badVersions.length,
        });
      }
      pushSample(report.houseTypePlanClassification, {
        houseTypeId: typeId,
        estateId: id(type.estateId) || null,
        versionCount: versions.length,
        versions: versions.slice(0, 12).map((row) => ({
          version: row.version, effectiveFromPeriod: row.effectiveFromPeriod,
          lineCount: Array.isArray(row.lines) ? row.lines.length : 0,
          clientMatches: id(row.clientId) === id(type.clientId),
          estateMatches: !row.estateId || !proposedEstateByType.get(typeId)
            || id(row.estateId) === proposedEstateByType.get(typeId),
        })),
        status,
        requiresOwnerDecision: versions.length === 0,
      });
    }

    // Detect case-insensitive name collisions using the proposed or existing Estate scope.
    const namesByScope = new Map();
    for (const type of houseTypes) {
      const typeId = id(type._id);
      const estateId = proposedEstateByType.get(typeId);
      if (!estateId || !norm(type.name)) continue;
      const key = `${id(type.clientId)}|${estateId}|${norm(type.name)}`;
      if (!namesByScope.has(key)) namesByScope.set(key, []);
      namesByScope.get(key).push(type);
    }
    for (const rows of namesByScope.values()) {
      if (rows.length < 2) continue;
      report.summary.houseTypeNameCollisions += 1;
      pushSample(report.houseTypeNameCollisions, {
        clientId: id(rows[0].clientId), estateId: proposedEstateByType.get(id(rows[0]._id)),
        normalizedName: norm(rows[0].name), houseTypeIds: rows.map((row) => id(row._id)),
        names: rows.map((row) => row.name),
      });
    }

    const configStatusCounts = {};
    for (const config of configs) {
      const configId = id(config._id);
      const house = houseById.get(id(config.houseId));
      const from = config.effectiveFrom == null ? null : new Date(config.effectiveFrom);
      const to = config.effectiveTo == null ? null : new Date(config.effectiveTo);
      const invalidRange = !from || !Number.isFinite(from.getTime())
        || (to && (!Number.isFinite(to.getTime()) || to <= from));
      let status;
      if (!house) status = 'orphan_config_house_missing';
      else if (id(house.clientId) !== id(config.clientId) || id(house.estateId) !== id(config.estateId)) status = 'house_client_or_estate_mismatch';
      else if (invalidRange) status = 'invalid_effective_range';
      else if (auditEvidence.has(configId)) status = 'audit_evidenced_intentional_candidate';
      else status = 'no_audit_evidence_ambiguous_requires_review';
      bump(configStatusCounts, status);
      pushSample(report.houseBillingConfigClassification, {
        houseBillingConfigId: configId,
        houseId: id(config.houseId),
        clientId: id(config.clientId),
        estateId: id(config.estateId),
        chargeType: config.chargeType || null,
        description: config.description || null,
        amountCents: Number.isSafeInteger(config.amountCents) ? config.amountCents : null,
        isActive: config.isActive === true,
        effectiveFrom: from && Number.isFinite(from.getTime()) ? from.toISOString() : null,
        effectiveTo: to && Number.isFinite(to.getTime()) ? to.toISOString() : null,
        hasMatchingAuditEvidence: auditEvidence.has(configId),
        status,
        requiresOwnerReview: true,
      });
    }
    report.summary.houseBillingConfigsByStatus = configStatusCounts;

    // Check overlap within the actual service identity: House + chargeType + description.
    for (const [houseId, rows] of configsByHouse.entries()) {
      const identities = new Map();
      for (const row of rows) {
        const key = `${String(row.chargeType || '').toUpperCase()}::${norm(row.description || row.chargeType || '')}`;
        if (!identities.has(key)) identities.set(key, []);
        identities.get(key).push(row);
      }
      for (const [identity, sameLine] of identities.entries()) {
        const pairs = [];
        for (let i = 0; i < sameLine.length; i += 1) {
          for (let j = i + 1; j < sameLine.length; j += 1) {
            if (intervalOverlaps(sameLine[i], sameLine[j])) {
              pairs.push([id(sameLine[i]._id), id(sameLine[j]._id)]);
            }
          }
        }
        if (pairs.length) {
          report.summary.duplicateOrOverlappingConfigGroups += 1;
          pushSample(report.overlappingBillingConfigGroups, {
            houseId, lineIdentity: identity, configIds: sameLine.map((row) => id(row._id)), overlappingPairs: pairs,
          });
        }
      }
    }

    const now = new Date();
    const houseSourceCounts = {};
    for (const house of houses) {
      const houseId = id(house._id);
      const source = house.billingSource || 'LEGACY_UNCLASSIFIED';
      const linkedType = house.houseTypeId ? typeById.get(id(house.houseTypeId)) : null;
      const linkedVersions = linkedType ? (versionsByType.get(id(linkedType._id)) || []) : [];
      const houseConfigs = configsByHouse.get(houseId) || [];
      const currentConfigs = houseConfigs.filter((row) => row.isActive === true
        && row.effectiveFrom && new Date(row.effectiveFrom) <= now
        && (row.effectiveTo == null || new Date(row.effectiveTo) > now)
        && id(row.clientId) === id(house.clientId) && id(row.estateId) === id(house.estateId));
      let status;
      let suggestedSources = [];
      if (source === 'LEGACY_UNCLASSIFIED') {
        const typeValid = linkedType
          && id(linkedType.clientId) === id(house.clientId)
          && id(linkedType.estateId) === id(house.estateId);
        const evidencedConfigs = houseConfigs.filter((row) => auditEvidence.has(id(row._id))
          && id(row.clientId) === id(house.clientId) && id(row.estateId) === id(house.estateId));
        const ambiguousConfigs = houseConfigs.filter((row) => !auditEvidence.has(id(row._id)));
        if (typeValid) suggestedSources.push({
          source: 'HOUSE_TYPE',
          confidence: linkedVersions.length ? 'candidate_plan_history_present' : 'blocked_missing_plan_history',
          requiresApproval: true,
        });
        if (evidencedConfigs.length) suggestedSources.push({
          source: 'HOUSE_CONFIG', confidence: 'audit_evidenced_candidate', requiresApproval: true,
        });
        if (ambiguousConfigs.length) suggestedSources.push({
          source: 'HOUSE_CONFIG', confidence: 'ambiguous_config_rows', requiresApproval: true,
        });
        if (Number.isFinite(Number(house.monthlyRent)) && Number(house.monthlyRent) > 0) suggestedSources.push({
          source: 'MONTHLY_RENT', confidence: 'legacy_value_candidate_not_proof_of_intent', requiresApproval: true,
        });
        if (!suggestedSources.length) suggestedSources.push({
          source: 'UNCONFIGURED', confidence: 'no_billing_source_evidence_found', requiresApproval: true,
        });
        const distinct = [...new Set(suggestedSources.map((item) => item.source))];
        status = distinct.length > 1
          ? 'legacy_source_ambiguous_multiple_candidates'
          : suggestedSources[0].confidence === 'blocked_missing_plan_history'
            ? 'legacy_source_requires_plan_history_decision'
            : 'legacy_source_requires_owner_approval';
      } else if (source === 'HOUSE_TYPE') {
        if (!linkedType || id(linkedType.clientId) !== id(house.clientId) || id(linkedType.estateId) !== id(house.estateId)) {
          status = 'configured_house_type_source_has_scope_mismatch';
        } else if (!linkedVersions.length) status = 'configured_house_type_source_missing_plan_history';
        else status = 'configured_house_type_source_consistent';
      } else if (source === 'HOUSE_CONFIG') {
        status = currentConfigs.length
          ? 'configured_house_config_source_has_current_lines'
          : 'configured_house_config_source_has_no_current_lines_zero_charge_behavior';
      } else if (source === 'MONTHLY_RENT') {
        status = Number.isFinite(Number(house.monthlyRent)) && Number(house.monthlyRent) >= 0
          ? 'configured_monthly_rent_source'
          : 'configured_monthly_rent_source_invalid_value';
      } else if (source === 'UNCONFIGURED') status = 'explicitly_unconfigured';
      else status = 'unknown_billing_source_value';
      bump(houseSourceCounts, status);
      pushSample(report.houseBillingSourceClassification, {
        houseId, clientId: id(house.clientId), estateId: id(house.estateId),
        houseNumber: house.houseNumber || null,
        storedBillingSource: source,
        houseTypeId: id(house.houseTypeId) || null,
        linkedPlanVersionCount: linkedVersions.length,
        configCount: houseConfigs.length,
        currentConfigCount: currentConfigs.length,
        monthlyRent: Number.isFinite(Number(house.monthlyRent)) ? Number(house.monthlyRent) : null,
        status,
        suggestedSources,
        requiresOwnerDecision: source === 'LEGACY_UNCLASSIFIED' || status.includes('mismatch')
          || status.includes('missing_plan_history') || status.includes('invalid'),
      });
    }
    report.summary.housesByBillingSourceStatus = houseSourceCounts;

    for (const version of planVersions) {
      if (!typeById.has(id(version.houseTypeId))) {
        report.summary.orphanPlanVersions += 1;
        pushSample(report.planVersionAnomalies, {
          planVersionId: id(version._id), houseTypeId: id(version.houseTypeId), reason: 'orphan_house_type_reference',
        });
      }
    }

    try {
      const indexes = await db.collection(collectionNames.houseTypes).listIndexes().toArray();
      const legacyKey = { clientId: 1, name: 1 };
      const targetKey = { clientId: 1, estateId: 1, name: 1 };
      for (const index of indexes) {
        const relevant = Object.keys(index.key || {}).some((field) => ['clientId', 'estateId', 'name'].includes(field));
        if (!relevant) continue;
        const exactTargetKeyUnique = exactKey(index.key, targetKey) && index.unique === true;
        report.houseTypeIndexes.push({
          name: index.name,
          key: index.key,
          unique: index.unique === true,
          collation: index.collation || null,
          exactLegacyClientNameKeyUnique: exactKey(index.key, legacyKey) && index.unique === true,
          exactEstateScopedNameKeyUnique: exactTargetKeyUnique,
          targetHasExpectedCaseInsensitiveCollation: exactTargetKeyUnique && expectedCaseInsensitiveCollation(index.collation),
        });
      }
      const hasExpectedTarget = report.houseTypeIndexes.some((index) =>
        index.exactEstateScopedNameKeyUnique && index.targetHasExpectedCaseInsensitiveCollation
      );
      const hasLegacyUnique = report.houseTypeIndexes.some((index) => index.exactLegacyClientNameKeyUnique);
      report.houseTypeIndexReadiness = {
        expectedEstateScopedUniqueIndexPresent: hasExpectedTarget,
        legacyClientNameUniqueIndexPresent: hasLegacyUnique,
        note: 'Index presence is diagnostic only; this classifier never creates or drops indexes.',
      };
    } catch (error) {
      report.migrationBlockers.push(`Unable to inspect HouseType indexes: ${error.message}`);
    }

    if (report.summary.houseTypeNameCollisions > 0) {
      report.migrationBlockers.push('Case-insensitive HouseType name collisions exist within one or more proposed Estate scopes.');
    }
    if (report.summary.orphanPlanVersions > 0) {
      report.migrationBlockers.push('Orphan HouseTypePlanVersion records exist.');
    }
    if (report.planVersionAnomalies.length > 0) {
      report.migrationBlockers.push('HouseType plan history contains duplicate periods/versions, gaps, invalid line identities or invalid values.');
    }
    if (report.summary.duplicateOrOverlappingConfigGroups > 0) {
      report.migrationBlockers.push('HouseBillingConfig contains overlapping effective ranges for one or more line identities.');
    }
    if (['orphan_config_house_missing', 'house_client_or_estate_mismatch', 'invalid_effective_range']
      .some((status) => (configStatusCounts[status] || 0) > 0)) {
      report.migrationBlockers.push('HouseBillingConfig contains orphaned, cross-scope or invalid effective-range records.');
    }
    if ((configStatusCounts.no_audit_evidence_ambiguous_requires_review || 0) > 0) {
      report.migrationBlockers.push('Some HouseBillingConfig rows lack positive audit evidence and require owner review; absence of audit is not proof they are copies.');
    }
    if (report.houseTypeIndexReadiness && !report.houseTypeIndexReadiness.expectedEstateScopedUniqueIndexPresent) {
      report.migrationBlockers.push('Expected estate-scoped HouseType unique index is absent or lacks the required case-insensitive collation.');
    }
    if (Object.entries(report.summary.houseTypesByEstateStatus).some(([status, count]) =>
      count > 0 && !['estate_scope_consistent'].includes(status)
    )) {
      report.migrationBlockers.push('One or more HouseTypes have missing, conflicting or unapproved Estate ownership classification.');
    }
    if ((report.summary.houseTypesByPlanStatus.missing_plan_history_requires_owner_effective_period || 0) > 0) {
      report.migrationBlockers.push('Some HouseTypes have no immutable plan history; initial effective periods require owner decisions.');
    }
    if ((houseSourceCounts.legacy_source_ambiguous_multiple_candidates || 0) > 0) {
      report.migrationBlockers.push('Some legacy Houses have multiple plausible billing sources and must remain unclassified.');
    }
    if (Object.entries(houseSourceCounts).some(([status, count]) => count > 0
      && (status.includes('scope_mismatch') || status.includes('invalid_value') || status.includes('unknown_billing_source')))) {
      report.migrationBlockers.push('One or more Houses have an invalid explicit billing source, ownership scope or amount.');
    }

    report.summary.auditEvidence = {
      configsWithMatchingBillingChangeAudit: auditEvidence.size,
      configsWithoutMatchingBillingChangeAudit: Math.max(0, configs.length - auditEvidence.size),
      interpretation: 'Positive evidence only; absence is ambiguous.',
    };
    report.summary.migrationBlockerCount = report.migrationBlockers.length;
    report.summary.samplesPerSection = SAMPLE_LIMIT;
    report.summary.completeCollectionScan = true;

    console.log(JSON.stringify(report, null, 2));
  } finally {
    await client.close();
  }
}

classify().catch((error) => {
  console.error(`G3.2 billing legacy classification failed: ${error.stack || error.message}`);
  process.exitCode = 1;
});
