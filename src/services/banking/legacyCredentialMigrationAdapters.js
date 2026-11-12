import {
  readLegacyRedisCredential as defaultLegacyReader,
} from './legacyRedisCredentialReader.js';

const CONNECTION_PROJECTION = Object.freeze({
  _id: 1,
  clientId: 1,
  provider: 1,
  credentialsRef: 1,
  credentialVersion: 1,
  status: 1,
  updatedAt: 1,
});

function requireFunction(value, name) {
  if (typeof value !== 'function') {
    throw new TypeError(`${name} must be a function`);
  }
}

function sameDestinationIdentity(row, entry) {
  return Boolean(row)
    && String(row._id) === entry.credentialsRef
    && String(row.clientId).trim().toLowerCase() === entry.clientId
    && String(row.provider).trim().toUpperCase() === entry.provider
    && Number.isSafeInteger(Number(row.credentialVersion))
    && Number(row.credentialVersion) === entry.credentialVersion;
}

/**
 * Build the live-service adapters used by the migration coordinator.
 *
 * Redis is deliberately narrowed to a GET-only object before it reaches
 * the legacy reader. The reader itself constructs the exact legacy key.
 *
 * Mongo queries are read-only except for the injected create-only importer.
 * No BankConnection write, Redis write, scan, key enumeration or deletion
 * is exposed by this adapter.
 */
export function createLegacyCredentialMigrationAdapters({
  BankConnection,
  BankCredential,
  redisClient,
  getConnectionSecret,
  importConnectionSecret,
  legacyCurrentKeyHex,
  legacyPreviousKeyHex = '',
  legacyReader = defaultLegacyReader,
} = {}) {
  if (!BankConnection || typeof BankConnection.find !== 'function'
    || typeof BankConnection.findOne !== 'function') {
    throw new TypeError('BankConnection model is required');
  }

  if (!BankCredential || typeof BankCredential.findOne !== 'function') {
    throw new TypeError('BankCredential model is required');
  }

  if (!redisClient || typeof redisClient.get !== 'function') {
    throw new TypeError('A Redis client with GET support is required');
  }

  requireFunction(getConnectionSecret, 'getConnectionSecret');
  requireFunction(importConnectionSecret, 'importConnectionSecret');
  requireFunction(legacyReader, 'legacyReader');

  if (typeof legacyCurrentKeyHex !== 'string' || !legacyCurrentKeyHex) {
    throw new TypeError('Legacy current encryption key is required');
  }

  return {
    async loadInventory() {
      // Intentionally unfiltered: pending, active, reauth_required,
      // disconnected and failed connections all belong in the inventory.
      return BankConnection
        .find({}, CONNECTION_PROJECTION)
        .lean();
    },

    async readCurrentConnection(connectionId) {
      return BankConnection
        .findOne({ _id: connectionId }, CONNECTION_PROJECTION)
        .lean();
    },

    async inspectDestinationCredential(entry) {
      const row = await BankCredential
        .findOne({ _id: entry.credentialsRef })
        .lean();

      if (!row) {
        return { status: 'absent' };
      }

      if (!sameDestinationIdentity(row, entry)) {
        return { status: 'conflict' };
      }

      // Do not trust matching metadata alone. This also verifies the
      // AES-GCM authentication tag and the associated owner/reference/version.
      // Errors propagate to the coordinator as destination_unavailable,
      // which is blocking and halts the migration.
      await getConnectionSecret(entry.credentialsRef, {
        clientId: entry.clientId,
        provider: entry.provider,
        expectedVersion: entry.credentialVersion,
      });

      return { status: 'present' };
    },

    async readLegacyCredential(entry) {
      // Do not pass the full ioredis instance to the legacy reader.
      // It receives precisely one operation: GET.
      const getOnlyRedis = Object.freeze({
        get: (key) => redisClient.get(key),
      });

      return legacyReader({
        redis: getOnlyRedis,
        credentialsRef: entry.credentialsRef,
        expectedVersion: entry.credentialVersion,
        currentKeyHex: legacyCurrentKeyHex,
        previousKeyHex: legacyPreviousKeyHex,
      });
    },

    async importConnectionSecret(credentialsRef, material, owner) {
      return importConnectionSecret(credentialsRef, material, owner);
    },
  };
}
