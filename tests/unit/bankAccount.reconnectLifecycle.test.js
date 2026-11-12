import '../setup.js';
import { jest } from '@jest/globals';

const bankAccountFindOne = jest.fn();
const bankAccountFindOneAndUpdate = jest.fn();
const bankAccountCreate = jest.fn();

const estateFindOne = jest.fn();
const bankConnectionFindOne = jest.fn();

const assertProviderOperational = jest.fn();
const getBankProviderCapabilities = jest.fn();

const getAdapterForConnection = jest.fn();
const authenticate = jest.fn();
const validateAccount = jest.fn();

const encrypt = jest.fn();
const hashForLookup = jest.fn();

const audit = jest.fn();
const loggerWarn = jest.fn();
const loggerError = jest.fn();

class FakeBankAccount {
  constructor(values = {}) {
    Object.assign(this, values);
    this._id ||= 'candidate-account-id';
  }

  toObject() {
    return { ...this };
  }

  static findOne = bankAccountFindOne;
  static findOneAndUpdate = bankAccountFindOneAndUpdate;
  static create = bankAccountCreate;
}

jest.unstable_mockModule('../../src/models/BankAccount.js', () => ({
  BankAccount: FakeBankAccount,
}));

jest.unstable_mockModule('../../src/models/Estate.js', () => ({
  Estate: { findOne: estateFindOne },
}));

jest.unstable_mockModule('../../src/models/BankConnection.js', () => ({
  BankConnection: { findOne: bankConnectionFindOne },
}));

jest.unstable_mockModule('../../src/services/banking/bank.factory.js', () => ({
  assertProviderOperational,
  getBankProviderCapabilities,
}));

jest.unstable_mockModule('../../src/services/connection.service.js', () => ({
  connectionService: { getAdapterForConnection },
}));

jest.unstable_mockModule('../../src/utils/encryption.js', () => ({
  encryptionUtil: {
    encrypt,
    hashForLookup,
  },
}));

jest.unstable_mockModule('../../src/services/banking/transactionIngestion.service.js', () => ({
  ingestNormalizedTransactionBatch: jest.fn(),
}));

jest.unstable_mockModule('../../src/services/banking/bankSync.service.js', () => ({
  bankSyncService: { synchronizeBankAccount: jest.fn() },
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

const { bankService } = await import('../../src/services/bank.service.js');

function makeExistingAccount(overrides = {}) {
  const row = {
    _id: 'existing-account-1',
    clientId: 'client-1',
    estateId: 'estate-old',
    connectionId: 'connection-old',
    provider: 'COOP',
    accountNumberEncrypted: 'old-ciphertext',
    accountNumberHash: 'hash-123',
    accountName: 'Old account name',
    currency: 'KES',
    connectionStatus: 'connected',
    validationStatus: 'validated',
    lastValidatedAt: new Date('2026-10-01T00:00:00.000Z'),
    entitlements: {
      poll: true,
      statement: true,
      balance: false,
      webhookIngest: false,
    },
    updatedAt: new Date('2026-11-01T12:00:00.000Z'),
    ...overrides,
  };

  row.toObject = () => {
    const { toObject, ...plain } = row;
    return plain;
  };

  return row;
}

function makePersistedAccount(overrides = {}) {
  return {
    _id: 'existing-account-1',
    clientId: 'client-1',
    estateId: 'estate-new',
    connectionId: 'connection-new',
    provider: 'COOP',
    accountNumberEncrypted: 'enc:123456789',
    accountNumberHash: 'hash-123',
    accountName: 'New account name',
    currency: 'KES',
    connectionStatus: 'connected',
    validationStatus: 'validated',
    lastValidatedAt: new Date('2026-11-11T12:00:00.000Z'),
    entitlements: {
      poll: true,
      statement: true,
      balance: true,
      webhookIngest: true,
    },
    updatedAt: new Date('2026-11-11T12:00:00.000Z'),
    ...overrides,
  };
}

describe('bank account reconnect lifecycle', () => {
  let existing;
  let connection;

  beforeEach(() => {
    existing = makeExistingAccount();
    connection = {
      _id: 'connection-new',
      clientId: 'client-1',
      provider: 'COOP',
      status: 'active',
      credentialVersion: 2,
    };

    bankAccountFindOne.mockReset();
    bankAccountFindOneAndUpdate.mockReset();
    bankAccountCreate.mockReset();
    estateFindOne.mockReset();
    bankConnectionFindOne.mockReset();

    assertProviderOperational.mockReset();
    getBankProviderCapabilities.mockReset();
    getAdapterForConnection.mockReset();
    authenticate.mockReset();
    validateAccount.mockReset();

    encrypt.mockReset();
    hashForLookup.mockReset();

    audit.mockReset();
    loggerWarn.mockReset();
    loggerError.mockReset();

    bankAccountFindOne.mockResolvedValue(existing);
    bankAccountFindOneAndUpdate.mockResolvedValue(makePersistedAccount());
    bankAccountCreate.mockResolvedValue(makePersistedAccount({
      _id: 'new-account-id',
      estateId: 'estate-new',
      connectionId: 'connection-new',
    }));

    estateFindOne.mockResolvedValue({ _id: 'estate-new', clientId: 'client-1' });
    bankConnectionFindOne.mockResolvedValue(connection);

    assertProviderOperational.mockReturnValue(undefined);
    getBankProviderCapabilities.mockReturnValue({
      polling: true,
      statementImport: true,
      balance: true,
      webhook: true,
    });

    authenticate.mockResolvedValue(undefined);
    validateAccount.mockResolvedValue({ valid: true });
    getAdapterForConnection.mockResolvedValue({ authenticate, validateAccount });

    encrypt.mockReturnValue('enc:123456789');
    hashForLookup.mockReturnValue('hash-123');

    audit.mockResolvedValue(undefined);
  });

  test('validates a detached candidate before atomically reconnecting the existing account', async () => {
    const result = await bankService.connectAccount(
      'client-1',
      'estate-new',
      {
        provider: 'COOP',
        accountNumber: '123456789',
        accountName: 'New account name',
        currency: 'KES',
        connectionId: 'connection-new',
        allowEstateReassignment: true,
      }
    );

    expect(validateAccount).toHaveBeenCalledTimes(1);
    const candidate = validateAccount.mock.calls[0][0];

    expect(candidate._id).toBe(existing._id);
    expect(candidate.estateId).toBe('estate-new');
    expect(candidate.connectionId).toBe('connection-new');
    expect(candidate.accountNumberEncrypted).toBe('enc:123456789');
    expect(candidate.validationStatus).toBe('pending');

    // The original live document was never mutated during provider validation.
    expect(existing.estateId).toBe('estate-old');
    expect(existing.connectionId).toBe('connection-old');
    expect(existing.connectionStatus).toBe('connected');
    expect(existing.entitlements.poll).toBe(true);

    const [filter, update, options] = bankAccountFindOneAndUpdate.mock.calls[0];

    expect(filter).toMatchObject({
      _id: existing._id,
      clientId: 'client-1',
      provider: 'COOP',
      accountNumberHash: 'hash-123',
      estateId: 'estate-old',
      connectionId: 'connection-old',
      connectionStatus: 'connected',
      validationStatus: 'validated',
      updatedAt: existing.updatedAt,
    });

    expect(update.$set).toMatchObject({
      estateId: 'estate-new',
      connectionId: 'connection-new',
      connectionStatus: 'connected',
      validationStatus: 'validated',
      accountNumberEncrypted: 'enc:123456789',
      entitlements: {
        poll: true,
        statement: true,
        balance: true,
        webhookIngest: true,
      },
    });
    expect(options).toMatchObject({ new: true, runValidators: true });

    expect(result.id).toBe(existing._id);
    expect(bankAccountFindOneAndUpdate).toHaveBeenCalledTimes(1);
    expect(bankAccountCreate).not.toHaveBeenCalled();

    expect(audit).toHaveBeenCalledTimes(2);
    expect(audit.mock.calls[0][0].action).toBe('BANK_ACCOUNT_CONNECTED');
    expect(audit.mock.calls[1][0]).toMatchObject({
      action: 'BANK_ACCOUNT_ESTATE_REASSIGNED',
      resourceId: existing._id,
      metadata: {
        previousEstateId: 'estate-old',
        newEstateId: 'estate-new',
        connectionId: 'connection-new',
      },
    });
  });

  test('provider validation failure leaves the existing account and audits untouched', async () => {
    validateAccount.mockRejectedValueOnce(new Error('provider rejected account'));

    await expect(
      bankService.connectAccount('client-1', 'estate-new', {
        provider: 'COOP',
        accountNumber: '123456789',
        accountName: 'New account name',
        connectionId: 'connection-new',
        allowEstateReassignment: true,
      })
    ).rejects.toThrow(/Account validation failed/i);

    expect(existing.estateId).toBe('estate-old');
    expect(existing.connectionId).toBe('connection-old');
    expect(existing.connectionStatus).toBe('connected');
    expect(existing.validationStatus).toBe('validated');
    expect(existing.entitlements.poll).toBe(true);

    expect(bankAccountFindOneAndUpdate).not.toHaveBeenCalled();
    expect(bankAccountCreate).not.toHaveBeenCalled();
    expect(audit).not.toHaveBeenCalled();
  });

  test('authentication failure does not persist a failed version over the existing account', async () => {
    authenticate.mockRejectedValueOnce(new Error('provider authentication failed'));

    await expect(
      bankService.connectAccount('client-1', 'estate-new', {
        provider: 'COOP',
        accountNumber: '123456789',
        accountName: 'New account name',
        connectionId: 'connection-new',
        allowEstateReassignment: true,
      })
    ).rejects.toThrow(/provider authentication failed/i);

    expect(bankAccountFindOneAndUpdate).not.toHaveBeenCalled();
    expect(bankAccountCreate).not.toHaveBeenCalled();
    expect(audit).not.toHaveBeenCalled();

    expect(existing.connectionId).toBe('connection-old');
    expect(existing.estateId).toBe('estate-old');
    expect(existing.connectionStatus).toBe('connected');
  });

  test('compare-and-set conflict prevents a stale reconnect from overwriting concurrent changes', async () => {
    bankAccountFindOneAndUpdate.mockResolvedValueOnce(null);

    await expect(
      bankService.connectAccount('client-1', 'estate-new', {
        provider: 'COOP',
        accountNumber: '123456789',
        accountName: 'New account name',
        connectionId: 'connection-new',
        allowEstateReassignment: true,
      })
    ).rejects.toThrow(/changed during provider validation/i);

    expect(bankAccountFindOneAndUpdate).toHaveBeenCalledTimes(1);
    expect(audit).not.toHaveBeenCalled();
    expect(existing.estateId).toBe('estate-old');
    expect(existing.connectionId).toBe('connection-old');
  });

  test('estate reassignment still requires explicit opt-in before provider validation', async () => {
    await expect(
      bankService.connectAccount('client-1', 'estate-new', {
        provider: 'COOP',
        accountNumber: '123456789',
        accountName: 'New account name',
        connectionId: 'connection-new',
      })
    ).rejects.toThrow(/allowEstateReassignment=true/i);

    expect(validateAccount).not.toHaveBeenCalled();
    expect(bankAccountFindOneAndUpdate).not.toHaveBeenCalled();
    expect(audit).not.toHaveBeenCalled();
  });

  test('a new account is inserted only after provider validation succeeds', async () => {
    bankAccountFindOne.mockResolvedValueOnce(null);

    let validated = false;
    validateAccount.mockImplementationOnce(async () => {
      validated = true;
      return { valid: true };
    });

    bankAccountCreate.mockImplementationOnce(async (data) => {
      expect(validated).toBe(true);
      return {
        ...data,
        _id: 'new-account-id',
        toObject() { return { ...this }; },
      };
    });

    const result = await bankService.connectAccount(
      'client-1',
      'estate-new',
      {
        provider: 'COOP',
        accountNumber: '123456789',
        accountName: 'New account name',
        connectionId: 'connection-new',
      }
    );

    expect(bankAccountFindOneAndUpdate).not.toHaveBeenCalled();
    expect(bankAccountCreate).toHaveBeenCalledTimes(1);
    expect(bankAccountCreate.mock.calls[0][0]).toMatchObject({
      clientId: 'client-1',
      provider: 'COOP',
      estateId: 'estate-new',
      connectionId: 'connection-new',
      connectionStatus: 'connected',
      validationStatus: 'validated',
    });
    expect(result.id).toBe('new-account-id');
    expect(audit).toHaveBeenCalledTimes(1);
    expect(audit.mock.calls[0][0].action).toBe('BANK_ACCOUNT_CONNECTED');
  });

  test('concurrent physical-account creation becomes a conflict, not an overwrite', async () => {
    bankAccountFindOne.mockResolvedValueOnce(null);
    bankAccountCreate.mockRejectedValueOnce({ code: 11000 });

    await expect(
      bankService.connectAccount('client-1', 'estate-new', {
        provider: 'COOP',
        accountNumber: '123456789',
        accountName: 'New account name',
        connectionId: 'connection-new',
      })
    ).rejects.toThrow(/linked concurrently/i);

    expect(bankAccountFindOneAndUpdate).not.toHaveBeenCalled();
    expect(audit).not.toHaveBeenCalled();
  });
});
