#!/usr/bin/env node
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import dotenv from 'dotenv';
import mongoose from 'mongoose';
import Redis from 'ioredis';

import {
  assertLegacyDestinationKeyringsDistinct,
  runLegacyCredentialMigration,
} from '../../src/services/banking/legacyCredentialMigration.js';
import {
  createLegacyCredentialMigrationAdapters,
} from '../../src/services/banking/legacyCredentialMigrationAdapters.js';

const SCRIPT_DIRECTORY = path.dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = path.resolve(SCRIPT_DIRECTORY, '../..');
const EXECUTE_APPROVAL = 'IMPORT_LEGACY_BANK_CREDENTIALS_TO_MONGODB';
const PRODUCTION_PREFLIGHT_APPROVAL = 'I_APPROVE_G4_PRODUCTION_READ_PREFLIGHT';
const PRODUCTION_EXECUTE_APPROVAL = 'I_APPROVE_G4_PRODUCTION_CREDENTIAL_IMPORT';

function fail(code, message) {
  const error = new Error(message);
  error.code = code;
  throw error;
}

function csvSet(value) {
  return new Set(
    String(value || '')
      .split(',')
      .map((item) => item.trim())
      .filter(Boolean)
  );
}

export function normalizeMongoAddress(value) {
  const raw = String(value || '').trim();
  if (!raw || /\s/.test(raw)) {
    fail('MONGO_ADDRESS_INVALID', 'MongoDB address is invalid');
  }

  let host;
  let port;

  if (raw.startsWith('[')) {
    const match = raw.match(/^\[([^\]]+)\](?::(\d+))?$/);
    if (!match) fail('MONGO_ADDRESS_INVALID', 'MongoDB IPv6 address is invalid');
    host = `[${match[1].toLowerCase()}]`;
    port = match[2] || '27017';
  } else {
    const colonCount = (raw.match(/:/g) || []).length;
    if (colonCount > 1) {
      // A bare IPv6 host has no unambiguous port. Treat it as a host and
      // assign MongoDB's default port; URI authorities should use brackets.
      host = `[${raw.toLowerCase()}]`;
      port = '27017';
    } else {
      const match = raw.match(/^([^:]+)(?::(\d+))?$/);
      if (!match) fail('MONGO_ADDRESS_INVALID', 'MongoDB host address is invalid');
      host = match[1].toLowerCase();
      port = match[2] || '27017';
    }
  }

  const numericPort = Number(port);
  if (!Number.isInteger(numericPort) || numericPort < 1 || numericPort > 65535) {
    fail('MONGO_ADDRESS_PORT_INVALID', 'MongoDB address port is invalid');
  }

  return `${host}:${numericPort}`;
}

/** Parse only non-secret target identity; never return username/password/query. */
export function parseMongoUri(uri) {
  if (typeof uri !== 'string' || !uri.trim()) {
    fail('MONGO_URI_REQUIRED', 'MONGODB_URI is required');
  }

  const match = uri.match(/^(mongodb(?:\+srv)?:\/\/)(.*)$/i);
  if (!match) {
    fail('MONGO_URI_SCHEME_INVALID', 'MONGODB_URI must use mongodb:// or mongodb+srv://');
  }

  const remainder = match[2];
  const pathStart = remainder.indexOf('/');
  if (pathStart < 0) {
    fail('MONGO_URI_DATABASE_REQUIRED', 'MONGODB_URI must include a database name');
  }

  const authority = remainder.slice(0, pathStart);
  const pathAndQuery = remainder.slice(pathStart + 1);
  const databaseSegment = pathAndQuery.split(/[/?#]/, 1)[0];
  if (!authority || !databaseSegment) {
    fail('MONGO_URI_DATABASE_REQUIRED', 'MONGODB_URI must include a database name');
  }

  let databaseName;
  try {
    databaseName = decodeURIComponent(databaseSegment);
  } catch {
    fail('MONGO_URI_DATABASE_INVALID', 'MONGODB_URI database name encoding is invalid');
  }

  const hostAuthority = authority.slice(authority.lastIndexOf('@') + 1);
  const rawSeeds = hostAuthority.split(',');
  if (!hostAuthority || rawSeeds.some((seed) => !seed)) {
    fail('MONGO_URI_HOST_INVALID', 'MONGODB_URI must include valid server addresses');
  }

  if (match[1].toLowerCase() === 'mongodb+srv://' && rawSeeds.length !== 1) {
    fail('MONGO_SRV_SEED_INVALID', 'mongodb+srv:// must contain exactly one seed hostname');
  }

  return {
    scheme: match[1].toLowerCase(),
    databaseName,
    seeds: rawSeeds.map(normalizeMongoAddress),
  };
}

export function assertMigrationTarget(uri, env = process.env) {
  const parsed = parseMongoUri(uri);
  const databaseAllowlist = csvSet(env.G4_MIGRATION_ALLOWED_DB_NAMES);
  const expectedDatabase = String(env.G4_MIGRATION_TARGET_DB_NAME || '').trim();
  const addressAllowlist = new Set(
    [...csvSet(env.G4_MIGRATION_ALLOWED_MONGO_ADDRESSES)]
      .map(normalizeMongoAddress)
  );

  if (!expectedDatabase || parsed.databaseName !== expectedDatabase
    || !databaseAllowlist.has(parsed.databaseName)) {
    fail(
      'MONGO_DATABASE_NOT_ALLOWLISTED',
      'MongoDB database must exactly match G4_MIGRATION_TARGET_DB_NAME and G4_MIGRATION_ALLOWED_DB_NAMES'
    );
  }

  if (/^(admin|local|config)$/i.test(parsed.databaseName)) {
    fail('MONGO_SYSTEM_DATABASE_REFUSED', 'Refusing to migrate a MongoDB system database');
  }

  if (!addressAllowlist.size || parsed.seeds.some((seed) => !addressAllowlist.has(seed))) {
    fail(
      'MONGO_SEED_NOT_ALLOWLISTED',
      'Every MongoDB URI seed must be explicitly allowlisted in G4_MIGRATION_ALLOWED_MONGO_ADDRESSES'
    );
  }

  const productionDatabase = /(^|[-_])(prod(?:uction)?|live)([-_]|$)/i
    .test(parsed.databaseName);

  if (productionDatabase
    && env.G4_MIGRATION_PRODUCTION_TARGET_APPROVAL !== PRODUCTION_PREFLIGHT_APPROVAL) {
    fail(
      'PRODUCTION_TARGET_APPROVAL_REQUIRED',
      'Production database access requires explicit G4_MIGRATION_PRODUCTION_TARGET_APPROVAL'
    );
  }

  return {
    ...parsed,
    allowedAddresses: addressAllowlist,
    productionDatabase,
  };
}

function validReference(value) {
  return typeof value === 'string'
    && value.trim().length >= 3
    && value.trim().length <= 160
    && /^[A-Za-z0-9][A-Za-z0-9._:/-]*$/.test(value.trim())
    && !/^(todo|none|unknown|n\/a|placeholder)$/i.test(value.trim());
}

export function assertExecutionApproval(env = process.env) {
  const exactApprovals = [
    ['G4_MIGRATION_EXECUTE_APPROVAL', EXECUTE_APPROVAL],
    ['G4_MIGRATION_CONNECTIONS_FROZEN', 'YES'],
    ['G4_MIGRATION_SOURCE_READ_ONLY_CONFIRMED', 'YES'],
    ['G4_MIGRATION_NO_PROVIDER_AUTH_CALLS', 'YES'],
    ['G4_MIGRATION_NO_REDIS_MUTATIONS', 'YES'],
  ];

  for (const [name, expected] of exactApprovals) {
    if (env[name] !== expected) {
      fail('EXECUTION_APPROVAL_INCOMPLETE', `Execution requires ${name}=${expected}`);
    }
  }

  const referenceNames = [
    'G4_MIGRATION_MONGO_BACKUP_REF',
    'G4_MIGRATION_DESTINATION_KEY_BACKUP_REF',
    'G4_MIGRATION_DESTINATION_KEY_RESTORE_TEST_REF',
    'G4_MIGRATION_MAINTENANCE_WINDOW_REF',
  ];

  for (const name of referenceNames) {
    if (!validReference(env[name])) {
      fail('EXECUTION_BACKUP_ATTESTATION_INCOMPLETE', `${name} must identify a recorded approval or backup`);
    }
  }

  const fingerprint = String(env.G4_MIGRATION_EXPECTED_INVENTORY_FINGERPRINT || '').trim();
  if (!/^[a-f0-9]{64}$/i.test(fingerprint)) {
    fail(
      'EXECUTION_INVENTORY_FINGERPRINT_REQUIRED',
      'Execute mode requires the exact 64-character dry-run inventory fingerprint'
    );
  }

  return fingerprint.toLowerCase();
}

export function assertConnectedMongoTarget(expected, connection) {
  if (!expected || !connection || connection.name !== expected.databaseName) {
    fail('CONNECTED_MONGO_DATABASE_MISMATCH', 'Connected MongoDB database does not match the approved target');
  }

  const servers = connection.getClient?.()?.topology?.description?.servers;
  const members = servers instanceof Map ? [...servers.keys()] : [];
  if (!members.length) {
    fail('CONNECTED_MONGO_TOPOLOGY_UNVERIFIED', 'Connected MongoDB topology members could not be verified');
  }

  const connectedAddresses = members.map(normalizeMongoAddress);
  const unapproved = connectedAddresses.filter(
    (address) => !expected.allowedAddresses.has(address)
  );
  if (unapproved.length) {
    fail(
      'CONNECTED_MONGO_MEMBER_NOT_ALLOWLISTED',
      'One or more connected MongoDB topology members are not allowlisted'
    );
  }

  return true;
}

function safeErrorCode(error) {
  const candidate = String(error?.code || error?.codeName || error?.name || 'UNCLASSIFIED');
  return /^[A-Za-z0-9_.-]{1,64}$/.test(candidate) ? candidate : 'UNCLASSIFIED';
}

function printReport(report, databaseName) {
  const counts = Object.fromEntries(
    Object.entries(report.counts || {}).sort(([a], [b]) => a.localeCompare(b))
  );

  console.log(JSON.stringify({
    migration: 'g4_legacy_redis_bank_credentials',
    mode: report.mode,
    database: databaseName,
    inventoryFingerprint: report.inventoryFingerprint,
    totalConnections: report.total,
    duplicateReferenceGroups: report.duplicateReferenceGroups,
    counts,
    inventoryStable: report.inventoryStable,
    halted: report.halted,
    complete: report.complete,
  }, null, 2));
}

function printHelp() {
  console.log([
    'G4 legacy Redis credential migration',
    '',
    'Default: read-only dry-run. No Mongo credential inserts and no Redis mutations.',
    'Execute: node scripts/migrations/20261112_g4_legacy_redis_credentials.js --execute',
    '',
    'Optional isolated-workspace setting:',
    '  G4_MIGRATION_ENV_FILE (absolute path to the existing protected .env; never printed)',
    '',
    'Required dry-run configuration:',
    '  MONGODB_URI',
    '  LEGACY_REDIS_URL',
    '  LEGACY_BANK_SECRETS_ENCRYPTION_KEY',
    '  LEGACY_BANK_SECRETS_ENCRYPTION_KEY_PREVIOUS (optional)',
    '  G4_MIGRATION_TARGET_DB_NAME',
    '  G4_MIGRATION_ALLOWED_DB_NAMES',
    '  G4_MIGRATION_ALLOWED_MONGO_ADDRESSES',
    '  BANK_SECRETS_ENCRYPTION_KEY (destination key)',
    '  BANK_SECRETS_ENCRYPTION_KEY_PREVIOUS (optional destination key)',
    '',
    'Execute additionally requires:',
    '  G4_MIGRATION_EXECUTE_APPROVAL=IMPORT_LEGACY_BANK_CREDENTIALS_TO_MONGODB',
    '  G4_MIGRATION_CONNECTIONS_FROZEN=YES',
    '  G4_MIGRATION_SOURCE_READ_ONLY_CONFIRMED=YES',
    '  G4_MIGRATION_NO_PROVIDER_AUTH_CALLS=YES',
    '  G4_MIGRATION_NO_REDIS_MUTATIONS=YES',
    '  G4_MIGRATION_MONGO_BACKUP_REF',
    '  G4_MIGRATION_DESTINATION_KEY_BACKUP_REF',
    '  G4_MIGRATION_DESTINATION_KEY_RESTORE_TEST_REF',
    '  G4_MIGRATION_MAINTENANCE_WINDOW_REF',
    '  G4_MIGRATION_EXPECTED_INVENTORY_FINGERPRINT (from the dry-run)',
    '',
    'Production database targets additionally require explicit production approvals.',
  ].join('\n'));
}

async function main(args = process.argv.slice(2)) {
  if (args.includes('--help') || args.includes('-h')) {
    printHelp();
    return;
  }

  if (args.some((arg) => arg !== '--execute')) {
    fail('ARGUMENT_INVALID', 'Only --execute or --help is supported');
  }

  const execute = args.includes('--execute');
  let phase = 'dotenv';
  let redisClient;
  let mongoConnected = false;

  try {
    // Normally load this project's .env. An isolated runtime workspace may
    // point at the original repo's existing .env without copying or modifying it.
    const configuredEnvFile = String(process.env.G4_MIGRATION_ENV_FILE || '').trim();
    const envFilePath = configuredEnvFile
      ? path.resolve(configuredEnvFile)
      : path.join(PROJECT_ROOT, '.env');
    dotenv.config({ path: envFilePath });

    phase = 'target_validation';
    const mongoUri = process.env.MONGODB_URI;
    const expectedTarget = assertMigrationTarget(mongoUri, process.env);
    const expectedFingerprint = execute
      ? assertExecutionApproval(process.env)
      : undefined;

    if (execute && expectedTarget.productionDatabase
      && process.env.G4_MIGRATION_PRODUCTION_EXECUTION_APPROVAL !== PRODUCTION_EXECUTE_APPROVAL) {
      fail(
        'PRODUCTION_EXECUTION_APPROVAL_REQUIRED',
        'Production execute mode requires G4_MIGRATION_PRODUCTION_EXECUTION_APPROVAL'
      );
    }

    const legacyRedisUrl = String(process.env.LEGACY_REDIS_URL || '').trim();
    if (!legacyRedisUrl) {
      fail('LEGACY_REDIS_URL_REQUIRED', 'LEGACY_REDIS_URL is required');
    }

    const legacyCurrentKeyHex = process.env.LEGACY_BANK_SECRETS_ENCRYPTION_KEY || '';
    const legacyPreviousKeyHex = process.env.LEGACY_BANK_SECRETS_ENCRYPTION_KEY_PREVIOUS || '';

    phase = 'application_modules';
    const importProjectModule = (relativePath) => import(
      pathToFileURL(path.join(PROJECT_ROOT, relativePath)).href
    );

    const [connectionModelModule, credentialModelModule, secretsModule, environmentModule] =
      await Promise.all([
        importProjectModule('src/models/BankConnection.js'),
        importProjectModule('src/models/BankCredential.js'),
        importProjectModule('src/services/banking/secretsManager.js'),
        importProjectModule('src/config/environment.js'),
      ]);

    const { BankConnection } = connectionModelModule;
    const { BankCredential } = credentialModelModule;
    const appEnv = environmentModule.env;

    if (appEnv.MONGODB_URI !== mongoUri) {
      fail('APPLICATION_MONGO_URI_MISMATCH', 'Application environment MongoDB URI differs from the approved migration target');
    }

    if (BankConnection.collection.collectionName !== 'bankconnections'
      || BankCredential.collection.collectionName !== 'bankcredentials') {
      fail('BANKING_COLLECTION_MAPPING_INVALID', 'Banking model collection mapping is not the expected G4 mapping');
    }

    secretsModule.assertBankCredentialEncryptionConfigured();
    assertLegacyDestinationKeyringsDistinct({
      legacyCurrentKeyHex,
      legacyPreviousKeyHex,
      destinationCurrentKeyHex: appEnv.BANK_SECRETS_ENCRYPTION_KEY,
      destinationPreviousKeyHex: appEnv.BANK_SECRETS_ENCRYPTION_KEY_PREVIOUS,
    });

    phase = 'mongo_connect';
    mongoose.connection.on('error', () => {});
    await mongoose.connect(mongoUri, {
      autoIndex: false,
      autoCreate: false,
      readPreference: 'primary',
      serverSelectionTimeoutMS: 15000,
      connectTimeoutMS: 10000,
      socketTimeoutMS: 30000,
      writeConcern: { w: 'majority', wtimeout: 15000 },
    });
    mongoConnected = true;

    phase = 'mongo_target_verification';
    assertConnectedMongoTarget(expectedTarget, mongoose.connection);

    if (BankConnection.db !== mongoose.connection || BankCredential.db !== mongoose.connection) {
      fail('BANKING_MODELS_WRONG_CONNECTION', 'Banking models are not bound to the verified MongoDB connection');
    }

    phase = 'legacy_redis_connect';
    redisClient = new Redis(legacyRedisUrl, {
      lazyConnect: true,
      enableOfflineQueue: false,
      maxRetriesPerRequest: 1,
      retryStrategy: () => null,
      reconnectOnError: () => false,
      autoResendUnfulfilledCommands: false,
      autoResubscribe: false,
      connectTimeout: 10000,
      commandTimeout: 10000,
      keyPrefix: '',
    });
    // ioredis emits connection errors. The failed command is handled by the
    // reader/coordinator; do not print a URI or provider-specific error detail.
    redisClient.on('error', () => {});
    await redisClient.connect();

    phase = 'migration';
    const adapters = createLegacyCredentialMigrationAdapters({
      BankConnection,
      BankCredential,
      redisClient,
      getConnectionSecret: secretsModule.getConnectionSecret,
      importConnectionSecret: secretsModule.importConnectionSecret,
      legacyCurrentKeyHex,
      legacyPreviousKeyHex,
    });

    const inventory = await adapters.loadInventory();
    const report = await runLegacyCredentialMigration({
      mode: execute ? 'execute' : 'dry-run',
      inventory,
      loadInventory: adapters.loadInventory,
      readCurrentConnection: adapters.readCurrentConnection,
      inspectDestinationCredential: adapters.inspectDestinationCredential,
      readLegacyCredential: adapters.readLegacyCredential,
      importConnectionSecret: adapters.importConnectionSecret,
      expectedInventoryFingerprint: expectedFingerprint,
    });

    printReport(report, expectedTarget.databaseName);
    if (!report.complete) {
      process.exitCode = 2;
    }
  } catch (error) {
    console.error(`MIGRATION_ABORTED phase=${phase} code=${safeErrorCode(error)}`);
    process.exitCode = 1;
  } finally {
    if (redisClient) {
      try { redisClient.disconnect(); } catch { /* best-effort socket close */ }
    }
    if (mongoConnected || mongoose.connection.readyState !== 0) {
      try { await mongoose.disconnect(); } catch { /* best-effort socket close */ }
    }
  }
}

const invokedPath = process.argv[1]
  ? pathToFileURL(path.resolve(process.argv[1])).href
  : '';

if (import.meta.url === invokedPath) {
  await main();
}
