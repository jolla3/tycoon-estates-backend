import {
  assertConnectedMongoTarget,
  assertExecutionApproval,
  assertMigrationTarget,
  normalizeMongoAddress,
  parseMongoUri,
} from '../../scripts/migrations/20261112_g4_legacy_redis_credentials.js';

const BASE_ENV = Object.freeze({
  G4_MIGRATION_TARGET_DB_NAME: 'tycoon_g4_test',
  G4_MIGRATION_ALLOWED_DB_NAMES: 'tycoon_g4_test,tycoon_g4_stage',
  G4_MIGRATION_ALLOWED_MONGO_ADDRESSES: '127.0.0.1:27017,127.0.0.2:27017',
});

const EXECUTION_ENV = Object.freeze({
  G4_MIGRATION_EXECUTE_APPROVAL: 'IMPORT_LEGACY_BANK_CREDENTIALS_TO_MONGODB',
  G4_MIGRATION_CONNECTIONS_FROZEN: 'YES',
  G4_MIGRATION_SOURCE_READ_ONLY_CONFIRMED: 'YES',
  G4_MIGRATION_NO_PROVIDER_AUTH_CALLS: 'YES',
  G4_MIGRATION_NO_REDIS_MUTATIONS: 'YES',
  G4_MIGRATION_MONGO_BACKUP_REF: 'backup-2026-11-12-a1',
  G4_MIGRATION_DESTINATION_KEY_BACKUP_REF: 'kms-backup-2026-11-12-b2',
  G4_MIGRATION_DESTINATION_KEY_RESTORE_TEST_REF: 'restore-test-2026-11-12-c3',
  G4_MIGRATION_MAINTENANCE_WINDOW_REF: 'change-2026-11-12-d4',
  G4_MIGRATION_EXPECTED_INVENTORY_FINGERPRINT: 'a'.repeat(64),
});

describe('G4 legacy migration CLI safety policy', () => {
  test('normalizes hostnames and explicit ports', () => {
    expect(normalizeMongoAddress('LOCALHOST')).toBe('localhost:27017');
    expect(normalizeMongoAddress('127.0.0.1:27018')).toBe('127.0.0.1:27018');
    expect(normalizeMongoAddress('[2001:db8::1]:27019')).toBe('[2001:db8::1]:27019');
  });

  test('parses Mongo URI target without returning credentials or query values', () => {
    const parsed = parseMongoUri(
      'mongodb://migration-user:secret%40value@127.0.0.1:27017,127.0.0.2:27017/tycoon_g4_test?authSource=admin'
    );

    expect(parsed).toEqual({
      scheme: 'mongodb://',
      databaseName: 'tycoon_g4_test',
      seeds: ['127.0.0.1:27017', '127.0.0.2:27017'],
    });
    expect(JSON.stringify(parsed)).not.toContain('migration-user');
    expect(JSON.stringify(parsed)).not.toContain('secret');
    expect(JSON.stringify(parsed)).not.toContain('authSource');
  });

  test('supports mongodb+srv seed parsing without exposing URI credentials', () => {
    const parsed = parseMongoUri(
      'mongodb+srv://user:secret@cluster.example.test/tycoon_g4_test?retryWrites=true'
    );

    expect(parsed.scheme).toBe('mongodb+srv://');
    expect(parsed.seeds).toEqual(['cluster.example.test:27017']);
    expect(JSON.stringify(parsed)).not.toContain('secret');
  });

  test('requires an explicit database name', () => {
    expect(() => parseMongoUri('mongodb://127.0.0.1:27017'))
      .toThrow('MONGODB_URI must include a database name');
  });

  test('requires exact database name and allowlist membership', () => {
    const target = assertMigrationTarget(
      'mongodb://127.0.0.1:27017/tycoon_g4_test',
      BASE_ENV
    );
    expect(target.databaseName).toBe('tycoon_g4_test');

    expect(() => assertMigrationTarget(
      'mongodb://127.0.0.1:27017/tycoon_g4_stage',
      BASE_ENV
    )).toThrow('MongoDB database must exactly match');
  });

  test('rejects a Mongo seed that is not allowlisted', () => {
    expect(() => assertMigrationTarget(
      'mongodb://127.0.0.9:27017/tycoon_g4_test',
      BASE_ENV
    )).toThrow('Every MongoDB URI seed must be explicitly allowlisted');
  });

  test('rejects MongoDB system databases', () => {
    expect(() => assertMigrationTarget(
      'mongodb://127.0.0.1:27017/admin',
      {
        ...BASE_ENV,
        G4_MIGRATION_TARGET_DB_NAME: 'admin',
        G4_MIGRATION_ALLOWED_DB_NAMES: 'admin',
      }
    )).toThrow('Refusing to migrate a MongoDB system database');
  });

  test('requires explicit production target approval', () => {
    const productionEnv = {
      ...BASE_ENV,
      G4_MIGRATION_TARGET_DB_NAME: 'tycoon_prod',
      G4_MIGRATION_ALLOWED_DB_NAMES: 'tycoon_prod',
    };

    expect(() => assertMigrationTarget(
      'mongodb://127.0.0.1:27017/tycoon_prod',
      productionEnv
    )).toThrow('Production database access requires explicit');

    expect(assertMigrationTarget(
      'mongodb://127.0.0.1:27017/tycoon_prod',
      {
        ...productionEnv,
        G4_MIGRATION_PRODUCTION_TARGET_APPROVAL: 'I_APPROVE_G4_PRODUCTION_READ_PREFLIGHT',
      }
    ).productionDatabase).toBe(true);
  });

  test('requires all execute approvals, backup references and fingerprint', () => {
    expect(assertExecutionApproval(EXECUTION_ENV)).toBe('a'.repeat(64));

    expect(() => assertExecutionApproval({
      ...EXECUTION_ENV,
      G4_MIGRATION_CONNECTIONS_FROZEN: 'NO',
    })).toThrow('Execution requires G4_MIGRATION_CONNECTIONS_FROZEN=YES');

    expect(() => assertExecutionApproval({
      ...EXECUTION_ENV,
      G4_MIGRATION_DESTINATION_KEY_RESTORE_TEST_REF: 'TODO',
    })).toThrow('G4_MIGRATION_DESTINATION_KEY_RESTORE_TEST_REF must identify');

    expect(() => assertExecutionApproval({
      ...EXECUTION_ENV,
      G4_MIGRATION_EXPECTED_INVENTORY_FINGERPRINT: 'stale',
    })).toThrow('Execute mode requires the exact 64-character');
  });

  test('verifies the connected database and every discovered Mongo member', () => {
    const target = assertMigrationTarget(
      'mongodb://127.0.0.1:27017/tycoon_g4_test',
      BASE_ENV
    );
    const connection = {
      name: 'tycoon_g4_test',
      getClient: () => ({
        topology: {
          description: {
            servers: new Map([
              ['127.0.0.1:27017', {}],
              ['127.0.0.2:27017', {}],
            ]),
          },
        },
      }),
    };

    expect(assertConnectedMongoTarget(target, connection)).toBe(true);
    expect(() => assertConnectedMongoTarget(target, {
      ...connection,
      name: 'wrong_database',
    })).toThrow('Connected MongoDB database does not match');
    expect(() => assertConnectedMongoTarget(target, {
      ...connection,
      getClient: () => ({
        topology: { description: { servers: new Map([['127.0.0.9:27017', {}]]) } },
      }),
    })).toThrow('not allowlisted');
  });
});
