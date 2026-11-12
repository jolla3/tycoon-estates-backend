import '../setup.js';
import { jest } from '@jest/globals';

const bankConnectionFindOne = jest.fn();
const bankConnectionFindById = jest.fn();
const bankConnectionFindOneAndUpdate = jest.fn();
const bankConnectionCreate = jest.fn();

const assertProviderOperational = jest.fn();
const createBankProviderForConnection = jest.fn();

const allocateCredentialsRef = jest.fn();
const putConnectionSecret = jest.fn();
const getConnectionSecret = jest.fn();
const deleteConnectionSecret = jest.fn();

const audit = jest.fn();
const loggerWarn = jest.fn();
const loggerError = jest.fn();
const authenticate = jest.fn();

jest.unstable_mockModule('../../src/models/BankConnection.js', () => ({
  BankConnection: {
    create: bankConnectionCreate,
    findOne: bankConnectionFindOne,
    findById: bankConnectionFindById,
    findOneAndUpdate: bankConnectionFindOneAndUpdate,
  },
  sanitizeBankConnection: jest.fn((doc) => doc),
}));

jest.unstable_mockModule('../../src/services/banking/bank.factory.js', () => ({
  assertProviderOperational,
  createBankProviderForConnection,
}));

jest.unstable_mockModule('../../src/services/banking/secretsManager.js', () => ({
  allocateCredentialsRef,
  putConnectionSecret,
  getConnectionSecret,
  deleteConnectionSecret,
}));

jest.unstable_mockModule('../../src/services/audit.service.js', () => ({
  audit,
}));

jest.unstable_mockModule('../../src/config/logger.js', () => ({
  logger: {
    warn: loggerWarn,
    error: loggerError,
    info: jest.fn(),
  },
}));

const { connectionService } = await import('../../src/services/connection.service.js');

function makeConnection(overrides = {}) {
  return {
    _id: 'connection-1',
    clientId: 'client-1',
    provider: 'COOP',
    status: 'reauth_required',
    credentialsRef: 'old-secret-ref',
    credentialVersion: 3,
    updatedAt: new Date('2026-11-01T10:00:00.000Z'),
    authMeta: {},
    ...overrides,
  };
}

describe('BankConnection lifecycle and credential rotation', () => {
  let original;
  let promoted;

  beforeEach(() => {
    original = makeConnection();
    promoted = makeConnection({
      status: 'active',
      credentialsRef: 'staged-secret-ref',
      credentialVersion: 4,
      updatedAt: new Date('2026-11-11T10:00:00.000Z'),
    });

    bankConnectionFindOne.mockReset();
    bankConnectionFindById.mockReset();
    bankConnectionFindOneAndUpdate.mockReset();
    bankConnectionCreate.mockReset();

    assertProviderOperational.mockReset();
    createBankProviderForConnection.mockReset();

    allocateCredentialsRef.mockReset();
    putConnectionSecret.mockReset();
    getConnectionSecret.mockReset();
    deleteConnectionSecret.mockReset();

    audit.mockReset();
    loggerWarn.mockReset();
    loggerError.mockReset();
    authenticate.mockReset();

    bankConnectionFindOne.mockResolvedValue(original);
    bankConnectionFindById.mockResolvedValue(original);
    bankConnectionFindOneAndUpdate.mockResolvedValue(promoted);

    allocateCredentialsRef.mockReturnValue('staged-secret-ref');
    putConnectionSecret.mockResolvedValue('staged-secret-ref');
    getConnectionSecret.mockResolvedValue({
      clientId: 'new-client',
      clientSecret: 'new-secret',
    });
    deleteConnectionSecret.mockResolvedValue(undefined);

    authenticate.mockResolvedValue(undefined);
    createBankProviderForConnection.mockReturnValue({ authenticate });

    audit.mockResolvedValue(undefined);
  });

  test('successful reauthorization promotes a new reference and retires the old secret', async () => {
    const result = await connectionService.reauthorize(
      'client-1',
      'connection-1',
      { clientId: 'new-client', clientSecret: 'new-secret' },
      'user-1'
    );

    expect(putConnectionSecret).toHaveBeenCalledWith(
      'staged-secret-ref',
      { clientId: 'new-client', clientSecret: 'new-secret' },
      { clientId: 'client-1', provider: 'COOP', credentialVersion: 4 }
    );

    expect(getConnectionSecret).toHaveBeenCalledWith(
      'staged-secret-ref',
      { clientId: 'client-1', provider: 'COOP', expectedVersion: 4 }
    );

    expect(createBankProviderForConnection).toHaveBeenCalledWith(
      'COOP',
      { clientId: 'new-client', clientSecret: 'new-secret' },
      { connectionId: 'connection-1', credentialVersion: 4 }
    );

    expect(authenticate).toHaveBeenCalledTimes(1);

    const [filter, update, options] = bankConnectionFindOneAndUpdate.mock.calls[0];

    expect(filter).toMatchObject({
      _id: 'connection-1',
      clientId: 'client-1',
      credentialsRef: 'old-secret-ref',
      credentialVersion: 3,
      status: 'reauth_required',
      updatedAt: original.updatedAt,
    });

    expect(update.$set).toMatchObject({
      credentialsRef: 'staged-secret-ref',
      credentialVersion: 4,
      status: 'active',
      updatedByUserId: 'user-1',
    });
    expect(options).toMatchObject({ new: true, runValidators: true });

    expect(deleteConnectionSecret).toHaveBeenCalledTimes(1);
    expect(deleteConnectionSecret).toHaveBeenCalledWith(
      'old-secret-ref',
      { clientId: 'client-1', provider: 'COOP', expectedVersion: 3 }
    );
    expect(audit).toHaveBeenCalledTimes(1);

    expect(result.status).toBe('active');
    expect(result.credentialVersion).toBe(4);
  });

  test('failed authentication keeps the existing connection credentials untouched', async () => {
    authenticate.mockRejectedValueOnce(new Error('provider rejected credentials'));

    await expect(
      connectionService.reauthorize(
        'client-1',
        'connection-1',
        { clientId: 'bad-client', clientSecret: 'bad-secret' },
        'user-1'
      )
    ).rejects.toThrow(/existing credentials were retained/i);

    expect(bankConnectionFindOneAndUpdate).not.toHaveBeenCalled();
    expect(deleteConnectionSecret).toHaveBeenCalledTimes(1);
    expect(deleteConnectionSecret).toHaveBeenCalledWith(
      'staged-secret-ref',
      { clientId: 'client-1', provider: 'COOP', expectedVersion: 4 }
    );
    expect(audit).not.toHaveBeenCalled();

    expect(original.credentialsRef).toBe('old-secret-ref');
    expect(original.credentialVersion).toBe(3);
    expect(original.status).toBe('reauth_required');
  });

  test('a stale compare-and-set result rejects concurrent reauthorization and removes only staged credentials', async () => {
    bankConnectionFindOneAndUpdate.mockResolvedValueOnce(null);

    await expect(
      connectionService.reauthorize(
        'client-1',
        'connection-1',
        { clientId: 'new-client', clientSecret: 'new-secret' },
        'user-1'
      )
    ).rejects.toThrow(/changed during reauthorization/i);

    expect(deleteConnectionSecret).toHaveBeenCalledTimes(1);
    expect(deleteConnectionSecret).toHaveBeenCalledWith(
      'staged-secret-ref',
      { clientId: 'client-1', provider: 'COOP', expectedVersion: 4 }
    );
    expect(audit).not.toHaveBeenCalled();
  });

  test('uncertain MongoDB write outcome retains staged credentials', async () => {
    bankConnectionFindOneAndUpdate.mockRejectedValueOnce(
      new Error('MongoDB network timeout after write')
    );

    await expect(
      connectionService.reauthorize(
        'client-1',
        'connection-1',
        { clientId: 'new-client', clientSecret: 'new-secret' },
        'user-1'
      )
    ).rejects.toThrow(/outcome is uncertain/i);

    // The staged reference may already be live in MongoDB.
    expect(deleteConnectionSecret).not.toHaveBeenCalled();
    expect(loggerError).toHaveBeenCalledTimes(1);
    expect(audit).not.toHaveBeenCalled();
  });

  test('pending connections cannot obtain an operational adapter', async () => {
    bankConnectionFindById.mockResolvedValueOnce(
      makeConnection({ status: 'pending' })
    );

    await expect(
      connectionService.getAdapterForConnection({
        _id: 'connection-1',
        clientId: 'client-1',
      })
    ).rejects.toThrow(/not active/i);

    expect(getConnectionSecret).not.toHaveBeenCalled();
    expect(createBankProviderForConnection).not.toHaveBeenCalled();
  });

  test('adapter construction uses the latest persisted active connection and pinned credential version', async () => {
    const persisted = makeConnection({
      status: 'active',
      credentialsRef: 'current-secret-ref',
      credentialVersion: 9,
    });

    bankConnectionFindById.mockResolvedValueOnce(persisted);

    const adapter = await connectionService.getAdapterForConnection({
      _id: 'connection-1',
      clientId: 'client-1',
      status: 'pending',
      credentialsRef: 'stale-secret-ref',
      credentialVersion: 2,
    });

    expect(getConnectionSecret).toHaveBeenCalledWith(
      'current-secret-ref',
      { clientId: 'client-1', provider: 'COOP', expectedVersion: 9 }
    );

    expect(createBankProviderForConnection).toHaveBeenCalledWith(
      'COOP',
      { clientId: 'new-client', clientSecret: 'new-secret' },
      { connectionId: 'connection-1', credentialVersion: 9 }
    );

    expect(adapter).toEqual({ authenticate });
  });

  test('a connection object from another client is rejected', async () => {
    bankConnectionFindById.mockResolvedValueOnce(
      makeConnection({ status: 'active' })
    );

    await expect(
      connectionService.getAdapterForConnection({
        _id: 'connection-1',
        clientId: 'another-client',
      })
    ).rejects.toThrow(/not found/i);

    expect(getConnectionSecret).not.toHaveBeenCalled();
  });

  test('create retains staged credentials when primary lookup currently finds no connection', async () => {
    const insertError = new Error('connection insert failed');
    const primaryRead = jest.fn().mockResolvedValue(null);

    bankConnectionCreate.mockRejectedValueOnce(insertError);
    bankConnectionFindOne.mockReturnValueOnce({ read: primaryRead });

    await expect(connectionService.create(
      'client-1',
      {
        provider: 'COOP',
        credentialMaterial: {
          clientId: 'new-client',
          clientSecret: 'new-secret',
        },
      },
      'user-1'
    )).rejects.toBe(insertError);

    expect(primaryRead).toHaveBeenCalledWith('primary');
    expect(bankConnectionFindOne).toHaveBeenCalledWith({
      clientId: 'client-1',
      credentialsRef: 'staged-secret-ref',
      credentialVersion: 1,
    });
    expect(deleteConnectionSecret).not.toHaveBeenCalled();
    expect(loggerWarn).toHaveBeenCalledWith(
      { clientId: 'client-1', provider: 'COOP' },
      'BankConnection create failed and no reference is currently visible; credentials retained for orphan reconciliation'
    );
  });

  test('create retains staged credentials when the connection insert committed despite an error', async () => {
    const insertError = new Error('connection acknowledgement lost');

    bankConnectionCreate.mockRejectedValueOnce(insertError);
    bankConnectionFindOne.mockResolvedValueOnce(makeConnection({
      clientId: 'client-1',
      provider: 'COOP',
      credentialsRef: 'staged-secret-ref',
      credentialVersion: 1,
      status: 'pending',
    }));

    await expect(connectionService.create(
      'client-1',
      {
        provider: 'COOP',
        credentialMaterial: {
          clientId: 'new-client',
          clientSecret: 'new-secret',
        },
      },
      'user-1'
    )).rejects.toBe(insertError);

    expect(deleteConnectionSecret).not.toHaveBeenCalled();
    expect(loggerWarn).toHaveBeenCalledWith(
      { clientId: 'client-1', provider: 'COOP' },
      'BankConnection create acknowledgement failed but its reference exists; credentials retained'
    );
  });

  test('create retains staged credentials when reference verification fails', async () => {
    const insertError = new Error('connection insert outcome unknown');

    bankConnectionCreate.mockRejectedValueOnce(insertError);
    bankConnectionFindOne.mockRejectedValueOnce(
      new Error('MongoDB primary unavailable')
    );

    await expect(connectionService.create(
      'client-1',
      {
        provider: 'COOP',
        credentialMaterial: {
          clientId: 'new-client',
          clientSecret: 'new-secret',
        },
      },
      'user-1'
    )).rejects.toBe(insertError);

    expect(deleteConnectionSecret).not.toHaveBeenCalled();
    expect(loggerError).toHaveBeenCalledWith(
      { clientId: 'client-1', provider: 'COOP' },
      'BankConnection creation outcome is uncertain; staged credentials retained'
    );
  });

});
