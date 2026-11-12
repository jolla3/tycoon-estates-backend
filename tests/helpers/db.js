// tests/helpers/db.js
//
// Integration tests require a dedicated disposable MongoDB replica set.
// clearTestDb() deletes every document in every application collection, so
// connection and cleanup are guarded by an explicit opt-in and a strict DB name.
import mongoose from 'mongoose';
import { verifyMongoTransactionSupport } from '../../src/config/database.js';

export const hasMongo = Boolean(process.env.MONGODB_URI);
export const canRunMongoIntegration = hasMongo
  && process.env.TYCOON_ALLOW_DESTRUCTIVE_TEST_DB === "1";
export const describeWithMongo = canRunMongoIntegration ? describe : describe.skip;

const SAFE_TEST_DB = /^tycoon_test_[a-z0-9_]{2,48}$/;
const DESTRUCTIVE_ACK = '1';
let validatedDatabaseName = null;
let validatedTopologyType = null;

function assertDestructiveTestDbAllowed() {
  if (process.env.TYCOON_ALLOW_DESTRUCTIVE_TEST_DB !== DESTRUCTIVE_ACK) {
    throw new Error(
      'Refusing destructive integration tests: set TYCOON_ALLOW_DESTRUCTIVE_TEST_DB=1 '
      + 'only for a dedicated disposable tycoon_test_* database.'
    );
  }
  if (!mongoose.connection?.db || mongoose.connection.readyState !== 1) {
    throw new Error('Refusing destructive test cleanup without an active MongoDB connection');
  }
  const name = mongoose.connection.name || '';
  if (!SAFE_TEST_DB.test(name) || /prod|production|live/i.test(name) || name !== validatedDatabaseName) {
    throw new Error(`Refusing destructive test cleanup for database "${name}"`);
  }
  const topologyType = mongoose.connection.client?.topology?.description?.type || '';
  if (!/^(ReplicaSet|Sharded)/.test(topologyType)
    || topologyType !== validatedTopologyType) {
    throw new Error(`Refusing destructive test cleanup without a validated replica set/sharded topology (got "${topologyType}")`);
  }
}

export async function connectTestDb() {
  if (!process.env.MONGODB_URI) {
    throw new Error('MONGODB_URI is required for integration tests');
  }
  if (process.env.TYCOON_ALLOW_DESTRUCTIVE_TEST_DB !== DESTRUCTIVE_ACK) {
    throw new Error(
      'Integration tests are destructive. Set TYCOON_ALLOW_DESTRUCTIVE_TEST_DB=1 '
      + 'and use a dedicated tycoon_test_* database.'
    );
  }

  await mongoose.connect(process.env.MONGODB_URI);
  const dbName = mongoose.connection.name || '';
  const topologyType = mongoose.connection.client?.topology?.description?.type || '';
  if (!SAFE_TEST_DB.test(dbName) || /prod|production|live/i.test(dbName)) {
    await mongoose.disconnect();
    throw new Error(
      `Refusing test database name "${dbName}"; expected tycoon_test_<disposable_name>`
    );
  }
  if (!/^(ReplicaSet|Sharded)/.test(topologyType)) {
    await mongoose.disconnect();
    throw new Error(
      `G3 integration tests require MongoDB replica-set/sharded transactions; got "${topologyType || 'unknown'}"`
    );
  }

  // Establish the production transaction-capability cache using the same live
  // hello check used at application startup. Never force the cached flag true.
  const transactionSupport = await verifyMongoTransactionSupport();
  if (transactionSupport !== true) {
    await mongoose.disconnect();
    throw new Error('G3 integration tests could not verify MongoDB multi-document transaction support');
  }

  validatedDatabaseName = dbName;
  validatedTopologyType = topologyType;
}

export async function clearTestDb() {
  if (!mongoose.connection?.db) return;
  assertDestructiveTestDbAllowed();
  const collections = await mongoose.connection.db.collections();
  const applicationCollections = collections.filter((collection) =>
    !collection.collectionName.startsWith('system.')
  );
  await Promise.all(applicationCollections.map((collection) => collection.deleteMany({})));
}

export async function disconnectTestDb() {
  try {
    if (mongoose.connection.readyState) await mongoose.disconnect();
  } finally {
    validatedDatabaseName = null;
    validatedTopologyType = null;
  }
}
