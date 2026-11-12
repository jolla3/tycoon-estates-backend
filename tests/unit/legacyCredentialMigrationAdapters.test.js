import { jest } from '@jest/globals';
import {
  createLegacyCredentialMigrationAdapters,
} from '../../src/services/banking/legacyCredentialMigrationAdapters.js';

const ENTRY = Object.freeze({
  connectionId: '111111111111111111111111',
  clientId: 'aaaaaaaaaaaaaaaaaaaaaaaa',
  provider: 'COOP',
  credentialsRef: 'secrets://bank/connections/coop/example/ref-1',
  credentialVersion: 3,
  status: 'disconnected',
  updatedAt: '2026-11-11T12:00:00.000Z',
});

const DESTINATION_ROW = Object.freeze({
  _id: ENTRY.credentialsRef,
  clientId: ENTRY.clientId,
  provider: ENTRY.provider,
  credentialVersion: ENTRY.credentialVersion,
  envelope: {
    format: 'tycoon-bank-credential',
    formatVersion: 1,
    algorithm: 'aes-256-gcm',
    keyId: '0123456789abcdef',
    iv: '0123456789abcdef01234567',
    authTag: '0123456789abcdef0123456789abcdef',
    ciphertext: 'YWJjZA==',
  },
});

function query(value) {
  return {
    lean: jest.fn().mockResolvedValue(value),
  };
}

function makeHarness(overrides = {}) {
  const inventory = [ENTRY];
  const destination = DESTINATION_ROW;

  const BankConnection = {
    find: jest.fn(() => query(inventory)),
    findOne: jest.fn(() => query(ENTRY)),
  };

  const BankCredential = {
    findOne: jest.fn(() => query(destination)),
  };

  const redisClient = {
    get: jest.fn(async () => 'encrypted-legacy-envelope'),
    set: jest.fn(),
    del: jest.fn(),
    scan: jest.fn(),
    keys: jest.fn(),
  };

  const getConnectionSecret = jest.fn(async () => ({
    username: 'verified-user',
  }));

  const importConnectionSecret = jest.fn(async () => ({
    status: 'imported',
  }));

  const legacyReader = jest.fn(async () => ({
    material: { username: 'legacy-user' },
    credentialVersion: ENTRY.credentialVersion,
  }));

  const adapters = createLegacyCredentialMigrationAdapters({
    BankConnection,
    BankCredential,
    redisClient,
    getConnectionSecret,
    importConnectionSecret,
    legacyCurrentKeyHex: 'a'.repeat(64),
    legacyPreviousKeyHex: 'b'.repeat(64),
    legacyReader,
    ...overrides,
  });

  return {
    adapters,
    BankConnection,
    BankCredential,
    redisClient,
    getConnectionSecret,
    importConnectionSecret,
    legacyReader,
  };
}

describe('legacy credential migration live adapters', () => {
  test('loads every connection without filtering lifecycle status', async () => {
    const h = makeHarness();

    const rows = await h.adapters.loadInventory();

    expect(rows).toEqual([ENTRY]);
    expect(h.BankConnection.find).toHaveBeenCalledTimes(1);
    expect(h.BankConnection.find).toHaveBeenCalledWith({}, {
      _id: 1,
      clientId: 1,
      provider: 1,
      credentialsRef: 1,
      credentialVersion: 1,
      status: 1,
      updatedAt: 1,
    });
  });

  test('reads one current connection by its exact id', async () => {
    const h = makeHarness();

    const row = await h.adapters.readCurrentConnection(ENTRY.connectionId);

    expect(row).toEqual(ENTRY);
    expect(h.BankConnection.findOne).toHaveBeenCalledWith(
      { _id: ENTRY.connectionId },
      expect.objectContaining({
        credentialsRef: 1,
        credentialVersion: 1,
        updatedAt: 1,
      })
    );
  });

  test('reports an absent destination without attempting decryption', async () => {
    const h = makeHarness({
      BankCredential: {
        findOne: jest.fn(() => query(null)),
      },
    });

    const result = await h.adapters.inspectDestinationCredential(ENTRY);

    expect(result).toEqual({ status: 'absent' });
    expect(h.getConnectionSecret).not.toHaveBeenCalled();
  });

  test('decrypts and authenticates a matching destination before accepting it', async () => {
    const h = makeHarness();

    const result = await h.adapters.inspectDestinationCredential(ENTRY);

    expect(result).toEqual({ status: 'present' });
    expect(h.getConnectionSecret).toHaveBeenCalledWith(
      ENTRY.credentialsRef,
      {
        clientId: ENTRY.clientId,
        provider: ENTRY.provider,
        expectedVersion: ENTRY.credentialVersion,
      }
    );
  });

  test('rejects a destination owner conflict without decrypting it', async () => {
    const conflictingRow = {
      ...DESTINATION_ROW,
      clientId: 'bbbbbbbbbbbbbbbbbbbbbbbb',
    };
    const h = makeHarness({
      BankCredential: {
        findOne: jest.fn(() => query(conflictingRow)),
      },
    });

    const result = await h.adapters.inspectDestinationCredential(ENTRY);

    expect(result).toEqual({ status: 'conflict' });
    expect(h.getConnectionSecret).not.toHaveBeenCalled();
  });

  test('rejects a destination version conflict without decrypting it', async () => {
    const conflictingRow = {
      ...DESTINATION_ROW,
      credentialVersion: 4,
    };
    const h = makeHarness({
      BankCredential: {
        findOne: jest.fn(() => query(conflictingRow)),
      },
    });

    const result = await h.adapters.inspectDestinationCredential(ENTRY);

    expect(result).toEqual({ status: 'conflict' });
    expect(h.getConnectionSecret).not.toHaveBeenCalled();
  });

  test('propagates destination verification failures instead of calling it present', async () => {
    const h = makeHarness({
      getConnectionSecret: jest.fn().mockRejectedValue(
        new Error('destination verification failed')
      ),
    });

    await expect(
      h.adapters.inspectDestinationCredential(ENTRY)
    ).rejects.toThrow('destination verification failed');
  });

  test('passes a GET-only Redis interface to the legacy reader', async () => {
    const h = makeHarness();

    const result = await h.adapters.readLegacyCredential(ENTRY);

    expect(result.credentialVersion).toBe(ENTRY.credentialVersion);
    expect(h.legacyReader).toHaveBeenCalledTimes(1);

    const readerArguments = h.legacyReader.mock.calls[0][0];

    expect(Object.keys(readerArguments.redis)).toEqual(['get']);
    expect(readerArguments.credentialsRef).toBe(ENTRY.credentialsRef);
    expect(readerArguments.expectedVersion).toBe(ENTRY.credentialVersion);
    expect(readerArguments.currentKeyHex).toBe('a'.repeat(64));
    expect(readerArguments.previousKeyHex).toBe('b'.repeat(64));

    await readerArguments.redis.get(
      `tycoon:bank:secret:${ENTRY.credentialsRef}`
    );

    expect(h.redisClient.get).toHaveBeenCalledWith(
      `tycoon:bank:secret:${ENTRY.credentialsRef}`
    );
    expect(h.redisClient.set).not.toHaveBeenCalled();
    expect(h.redisClient.del).not.toHaveBeenCalled();
    expect(h.redisClient.scan).not.toHaveBeenCalled();
    expect(h.redisClient.keys).not.toHaveBeenCalled();
  });

  test('forwards the exact original reference, material and owner to the importer', async () => {
    const h = makeHarness();
    const material = { clientId: 'legacy-app', password: 'redacted-fixture' };
    const owner = {
      clientId: ENTRY.clientId,
      provider: ENTRY.provider,
      credentialVersion: ENTRY.credentialVersion,
    };

    const result = await h.adapters.importConnectionSecret(
      ENTRY.credentialsRef,
      material,
      owner
    );

    expect(result).toEqual({ status: 'imported' });
    expect(h.importConnectionSecret).toHaveBeenCalledWith(
      ENTRY.credentialsRef,
      material,
      owner
    );
  });

  test('requires all security-critical injected dependencies', () => {
    expect(() => createLegacyCredentialMigrationAdapters())
      .toThrow('BankConnection model is required');

    expect(() => createLegacyCredentialMigrationAdapters({
      BankConnection: { find() {}, findOne() {} },
    })).toThrow('BankCredential model is required');
  });
});
