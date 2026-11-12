import crypto from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';

const PROVIDERS = new Set(['COOP', 'KCB', 'EQUITY', 'NCBA']);
const STATUSES = new Set([
  'pending',
  'active',
  'reauth_required',
  'disconnected',
  'failed',
]);

const SOURCE_ERRORS = Object.freeze({
  LEGACY_CREDENTIAL_MISSING: 'source_missing',
  LEGACY_CREDENTIAL_KEY_UNAVAILABLE: 'legacy_key_unavailable',
  LEGACY_CREDENTIAL_VERSION_MISSING: 'legacy_version_missing',
  LEGACY_CREDENTIAL_VERSION_MISMATCH: 'version_mismatch',
  LEGACY_CREDENTIAL_ENVELOPE_INVALID: 'malformed_source',
  LEGACY_CREDENTIAL_INTEGRITY_FAILED: 'source_integrity_failed',
  LEGACY_CREDENTIAL_RECORD_INVALID: 'malformed_record',
  LEGACY_REDIS_UNAVAILABLE: 'source_unavailable',
  LEGACY_REDIS_CLIENT_INVALID: 'configuration_error',
  LEGACY_CREDENTIAL_KEY_CONFIGURATION_INVALID: 'configuration_error',
  LEGACY_CREDENTIAL_EXPECTED_VERSION_INVALID: 'configuration_error',
});

const BLOCKING_STATUSES = new Set([
  'invalid_identity',
  'missing_reference',
  'duplicate_reference',
  'inventory_unavailable',
  'inventory_changed',
  'inventory_recheck_failed',
  'destination_unavailable',
  'destination_conflict',
  'destination_invalid',
  'destination_source_mismatch',
  'source_missing',
  'legacy_key_unavailable',
  'legacy_version_missing',
  'version_mismatch',
  'malformed_source',
  'source_integrity_failed',
  'malformed_record',
  'source_unavailable',
  'configuration_error',
  'source_read_error',
  'import_error',
]);

function safeString(value) {
  return value == null ? '' : String(value).trim();
}

function canonicalDate(value) {
  if (value == null || value === '') return '';

  const date = value instanceof Date ? value : new Date(value);

  return Number.isFinite(date.getTime())
    ? date.toISOString()
    : `invalid:${safeString(value)}`;
}

function normalizeConnection(row) {
  return {
    connectionId: safeString(row?._id),
    clientId: safeString(row?.clientId).toLowerCase(),
    provider: safeString(row?.provider).toUpperCase(),
    credentialsRef: safeString(row?.credentialsRef),
    credentialVersion: row?.credentialVersion,
    status: safeString(row?.status).toLowerCase(),
    updatedAt: canonicalDate(row?.updatedAt),
  };
}

function validIdentity(entry) {
  return (
    /^[0-9a-f]{24}$/.test(entry.connectionId) &&
    /^[0-9a-f]{24}$/.test(entry.clientId) &&
    PROVIDERS.has(entry.provider) &&
    entry.credentialsRef.length >= 1 &&
    entry.credentialsRef.length <= 512 &&
    Number.isSafeInteger(entry.credentialVersion) &&
    entry.credentialVersion >= 1 &&
    STATUSES.has(entry.status)
  );
}

function fingerprintRows(entries) {
  const canonical = [...entries]
    .sort((a, b) => {
      const byId = a.connectionId.localeCompare(b.connectionId);
      return byId || JSON.stringify(a).localeCompare(JSON.stringify(b));
    });

  return crypto.createHash('sha256')
    .update(JSON.stringify(canonical), 'utf8')
    .digest('hex');
}

/**
 * Validate and fingerprint the complete persisted BankConnection inventory.
 * Raw references are retained only for the internal execution path.
 */
export function buildLegacyCredentialMigrationPlan(inventory) {
  if (!Array.isArray(inventory)) {
    throw new TypeError('BankConnection inventory must be an array');
  }

  const entries = inventory.map(normalizeConnection);
  const references = new Map();

  for (const entry of entries) {
    if (!entry.credentialsRef) continue;
    references.set(
      entry.credentialsRef,
      (references.get(entry.credentialsRef) || 0) + 1
    );
  }

  const plannedEntries = entries.map((entry) => ({
    ...entry,
    valid: validIdentity(entry),
    duplicateReference: Boolean(
      entry.credentialsRef &&
      references.get(entry.credentialsRef) > 1
    ),
  }));

  return {
    fingerprint: fingerprintRows(entries),
    total: entries.length,
    entries: plannedEntries,
    duplicateReferenceGroups: [...references.values()]
      .filter((count) => count > 1).length,
  };
}

/**
 * Validate that source and destination encryption keyrings are disjoint.
 * Raw key values are never included in errors or returned data.
 */
export function assertLegacyDestinationKeyringsDistinct({
  legacyCurrentKeyHex,
  legacyPreviousKeyHex = '',
  destinationCurrentKeyHex,
  destinationPreviousKeyHex = '',
} = {}) {
  const source = [
    ['legacy current key', legacyCurrentKeyHex],
    ['legacy previous key', legacyPreviousKeyHex],
  ];
  const destination = [
    ['destination current key', destinationCurrentKeyHex],
    ['destination previous key', destinationPreviousKeyHex],
  ];

  for (const [name, value] of [
    source[0],
    destination[0],
  ]) {
    if (
      typeof value !== 'string' ||
      !/^[0-9a-f]{64}$/i.test(value)
    ) {
      throw new Error(`${name} must contain exactly 64 hexadecimal characters`);
    }
  }

  for (const [name, value] of [...source, ...destination]) {
    if (
      value !== '' &&
      (typeof value !== 'string' || !/^[0-9a-f]{64}$/i.test(value))
    ) {
      throw new Error(`${name} must contain exactly 64 hexadecimal characters`);
    }
  }

  const sourceKeys = source
    .filter(([, value]) => value)
    .map(([, value]) => value.toLowerCase());

  const destinationKeys = destination
    .filter(([, value]) => value)
    .map(([, value]) => value.toLowerCase());

  if (new Set(sourceKeys).size !== sourceKeys.length) {
    throw new Error('Legacy current and previous encryption keys must differ');
  }

  if (new Set(destinationKeys).size !== destinationKeys.length) {
    throw new Error('Destination current and previous encryption keys must differ');
  }

  if (sourceKeys.some((key) => destinationKeys.includes(key))) {
    throw new Error('Legacy and destination encryption keyrings must be distinct');
  }

  return true;
}

function sameConnection(expected, actual) {
  if (!actual) return false;

  return isDeepStrictEqual(
    normalizeConnection(actual),
    {
      connectionId: expected.connectionId,
      clientId: expected.clientId,
      provider: expected.provider,
      credentialsRef: expected.credentialsRef,
      credentialVersion: expected.credentialVersion,
      status: expected.status,
      updatedAt: expected.updatedAt,
    }
  );
}

function sourceFailure(error) {
  const code = error?.code || '';
  const status = SOURCE_ERRORS[code] || 'source_read_error';

  return {
    status,
    // Known record-level failures can be classified and skipped. An
    // unclassified exception is operationally uncertain and must halt.
    fatal: !Object.prototype.hasOwnProperty.call(SOURCE_ERRORS, code)
      || status === 'source_unavailable'
      || status === 'configuration_error',
  };
}

/**
 * Run the migration against injected dependencies.
 *
 * Dependencies:
 * - inventory: initial projected BankConnection documents
 * - loadInventory(): reload complete inventory for final drift check
 * - readCurrentConnection(id): read one connection before processing
 * - inspectDestinationCredential(entry): {status:'absent'|'present'|'conflict'|'invalid'}
 * - readLegacyCredential(entry): legacy GET + authenticated decrypt
 * - importConnectionSecret(ref, material, owner/version): create-only Mongo import
 *
 * No Redis or Mongo client is created here. The CLI owns those connections.
 */
export async function runLegacyCredentialMigration({
  mode = 'dry-run',
  inventory,
  loadInventory,
  readCurrentConnection,
  inspectDestinationCredential,
  readLegacyCredential,
  importConnectionSecret,
  expectedInventoryFingerprint,
} = {}) {
  if (!['dry-run', 'execute'].includes(mode)) {
    throw new Error('Migration mode must be dry-run or execute');
  }

  for (const [name, fn] of [
    ['loadInventory', loadInventory],
    ['readCurrentConnection', readCurrentConnection],
    ['inspectDestinationCredential', inspectDestinationCredential],
    ['readLegacyCredential', readLegacyCredential],
  ]) {
    if (typeof fn !== 'function') {
      throw new TypeError(`${name} dependency is required`);
    }
  }

  if (mode === 'execute' && typeof importConnectionSecret !== 'function') {
    throw new TypeError('importConnectionSecret dependency is required in execute mode');
  }

  const plan = buildLegacyCredentialMigrationPlan(inventory);

  if (
    mode === 'execute' &&
    expectedInventoryFingerprint !== plan.fingerprint
  ) {
    throw new Error('Expected inventory fingerprint does not match current inventory');
  }

  const counts = Object.create(null);
  let halted = false;
  let inventoryStable = true;

  const record = (status) => {
    counts[status] = (counts[status] || 0) + 1;
  };

  // Execute mode must reject structural inventory problems before it reads
  // a single legacy secret or writes any destination credential. This avoids
  // partial imports when a duplicate or malformed row appears later.
  if (mode === 'execute') {
    let structuralBlocker = false;

    for (const entry of plan.entries) {
      if (!entry.credentialsRef) {
        record('missing_reference');
        structuralBlocker = true;
      }

      if (entry.credentialsRef && !entry.valid) {
        record('invalid_identity');
        structuralBlocker = true;
      }

      if (entry.duplicateReference) {
        record('duplicate_reference');
        structuralBlocker = true;
      }
    }

    if (structuralBlocker) {
      halted = true;
    }
  }

  for (const entry of plan.entries) {
    if (halted) break;

    if (!entry.credentialsRef) {
      record('missing_reference');
      continue;
    }

    if (!entry.valid) {
      record('invalid_identity');
      continue;
    }

    if (entry.duplicateReference) {
      record('duplicate_reference');
      continue;
    }

    let current;

    try {
      current = await readCurrentConnection(entry.connectionId);
    } catch {
      record('inventory_unavailable');
      halted = true;
      break;
    }

    if (!sameConnection(entry, current)) {
      record('inventory_changed');
      inventoryStable = false;
      halted = true;
      break;
    }

    let destination;

    try {
      destination = await inspectDestinationCredential(entry);
    } catch {
      record('destination_unavailable');
      halted = true;
      break;
    }

    if (!destination || !['absent', 'present', 'conflict', 'invalid'].includes(destination.status)) {
      record('destination_unavailable');
      halted = true;
      break;
    }

    if (destination.status === 'conflict') {
      record('destination_conflict');
      if (mode === 'execute') halted = true;
      continue;
    }

    if (destination.status === 'invalid') {
      record('destination_invalid');
      if (mode === 'execute') halted = true;
      continue;
    }

    if (destination.status === 'present') {
      record('already_present');
      continue;
    }

    let legacy;

    try {
      legacy = await readLegacyCredential(entry);
    } catch (error) {
      const failure = sourceFailure(error);
      record(failure.status);
      if (failure.fatal || mode === 'execute') {
        // Execution is stricter than preflight: any source read failure
        // after the preflight must stop further imports.
        halted = true;
      }
      continue;
    }

    if (
      !legacy ||
      !legacy.material ||
      typeof legacy.material !== 'object' ||
      Array.isArray(legacy.material)
    ) {
      record('malformed_record');
      if (mode === 'execute') halted = true;
      continue;
    }

    if (
      !Number.isSafeInteger(legacy.credentialVersion) ||
      legacy.credentialVersion < 1
    ) {
      record('legacy_version_missing');
      if (mode === 'execute') halted = true;
      continue;
    }

    if (legacy.credentialVersion !== entry.credentialVersion) {
      record('version_mismatch');
      if (mode === 'execute') halted = true;
      continue;
    }

    if (mode === 'dry-run') {
      record('ready_to_import');
      continue;
    }

    // Re-read the authoritative connection after Redis decryption and
    // immediately before writing the destination credential.
    let currentBeforeImport;

    try {
      currentBeforeImport = await readCurrentConnection(entry.connectionId);
    } catch {
      record('inventory_unavailable');
      halted = true;
      break;
    }

    if (!sameConnection(entry, currentBeforeImport)) {
      record('inventory_changed');
      inventoryStable = false;
      halted = true;
      break;
    }

    try {
      const result = await importConnectionSecret(
        entry.credentialsRef,
        legacy.material,
        {
          clientId: entry.clientId,
          provider: entry.provider,
          credentialVersion: entry.credentialVersion,
        }
      );

      if (result?.status === 'imported') {
        record('imported');
      } else if (result?.status === 'already_present') {
        record('already_present');
      } else {
        record('import_error');
        halted = true;
      }
    } catch {
      // Never delete, overwrite or blindly retry after an import error.
      // The create-only importer owns reconciliation of ambiguous writes.
      record('import_error');
      halted = true;
    }
  }

  try {
    const finalInventory = await loadInventory();
    const finalPlan = buildLegacyCredentialMigrationPlan(finalInventory);

    if (finalPlan.fingerprint !== plan.fingerprint) {
      record('inventory_changed');
      inventoryStable = false;
    }
  } catch {
    record('inventory_recheck_failed');
    inventoryStable = false;
  }

  const hasBlockingStatus = Object.keys(counts).some(
    (status) => BLOCKING_STATUSES.has(status)
  );

  return {
    mode,
    inventoryFingerprint: plan.fingerprint,
    total: plan.total,
    duplicateReferenceGroups: plan.duplicateReferenceGroups,
    counts: { ...counts },
    inventoryStable,
    halted,
    complete: !hasBlockingStatus && inventoryStable && !halted,
  };
}
