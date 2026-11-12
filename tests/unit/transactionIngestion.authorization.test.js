import '../setup.js';
import { jest } from '@jest/globals';

const bankAccountFindById = jest.fn();
const bankConnectionFindById = jest.fn();

const bankTransactionFindOne = jest.fn();
const bankTransactionCreate = jest.fn();
const bankTransactionFindById = jest.fn();
const bankTransactionFindOneAndUpdate = jest.fn();

const claimBankTransaction = jest.fn();
const failClaim = jest.fn();
const reconcile = jest.fn();

jest.unstable_mockModule('../../src/models/BankAccount.js', () => ({
  BankAccount: { findById: bankAccountFindById },
}));

jest.unstable_mockModule('../../src/models/BankConnection.js', () => ({
  BankConnection: { findById: bankConnectionFindById },
}));

jest.unstable_mockModule('../../src/models/BankTransaction.js', () => ({
  BankTransaction: {
    findOne: bankTransactionFindOne,
    create: bankTransactionCreate,
    findById: bankTransactionFindById,
    findOneAndUpdate: bankTransactionFindOneAndUpdate,
  },
}));

jest.unstable_mockModule('../../src/services/banking/processingClaim.js', () => ({
  claimBankTransaction,
  completeClaim: jest.fn(),
  failClaim,
}));

jest.unstable_mockModule('../../src/services/reconciliation.service.js', () => ({
  reconciliationService: { reconcile },
}));

const {
  resolveIngestionContext,
  ingestNormalizedTransaction,
  processBankTransaction,
} = await import('../../src/services/banking/transactionIngestion.service.js');

function makeAccount(overrides = {}) {
  return {
    _id: 'account-1',
    clientId: 'client-1',
    estateId: 'estate-1',
    provider: 'COOP',
    connectionStatus: 'connected',
    validationStatus: 'validated',
    connectionId: 'connection-current',
    entitlements: {
      poll: true,
      statement: true,
      webhookIngest: true,
    },
    ...overrides,
  };
}

function makeConnection(overrides = {}) {
  return {
    _id: 'connection-current',
    clientId: 'client-1',
    provider: 'COOP',
    status: 'active',
    ...overrides,
  };
}

function makeNormalized(overrides = {}) {
  return {
    provider: 'COOP',
    providerTransactionId: 'provider-txn-1',
    eventType: 'CREDIT',
    amountCents: 125000,
    currency: 'KES',
    transactionDate: new Date('2026-11-10T12:00:00.000Z'),
    sourceChannel: 'webhook',
    ...overrides,
  };
}

describe('authoritative transaction ingestion authorization', () => {
  let account;
  let connection;

  beforeEach(() => {
    account = makeAccount();
    connection = makeConnection();

    bankAccountFindById.mockReset();
    bankConnectionFindById.mockReset();

    bankTransactionFindOne.mockReset();
    bankTransactionCreate.mockReset();
    bankTransactionFindById.mockReset();
    bankTransactionFindOneAndUpdate.mockReset();

    claimBankTransaction.mockReset();
    failClaim.mockReset();
    reconcile.mockReset();

    bankAccountFindById.mockResolvedValue(account);
    bankConnectionFindById.mockResolvedValue(connection);
    bankTransactionFindOne.mockResolvedValue(null);
    bankTransactionCreate.mockImplementation(async (value) => ({
      _id: 'transaction-1',
      ...value,
    }));
    bankTransactionFindOneAndUpdate.mockResolvedValue(null);

    claimBankTransaction.mockResolvedValue({ claimed: false, doc: null, claimToken: null });
    failClaim.mockResolvedValue(null);
    reconcile.mockResolvedValue(undefined);
  });

  test('reloads the persisted account rather than trusting a supplied document snapshot', async () => {
    const context = await resolveIngestionContext({
      bankAccount: { ...account },
      ingestionChannel: 'poll',
    });

    expect(bankAccountFindById).toHaveBeenCalledWith('account-1');
    expect(bankConnectionFindById).toHaveBeenCalledWith('connection-current');
    expect(context.account).toBe(account);
    expect(context.connection).toBe(connection);
  });

  test('rejects a stale account snapshot after connection reassignment', async () => {
    await expect(
      resolveIngestionContext({
        bankAccount: { ...account, connectionId: 'old-connection' },
        ingestionChannel: 'poll',
      })
    ).rejects.toThrow(/snapshot is stale/i);

    expect(bankConnectionFindById).not.toHaveBeenCalled();
  });

  test('rejects an explicit connection ID that is not the current account association', async () => {
    await expect(
      resolveIngestionContext({
        bankAccount: account,
        connectionId: 'another-connection',
        ingestionChannel: 'poll',
      })
    ).rejects.toThrow(/current connection/i);

    expect(bankConnectionFindById).not.toHaveBeenCalled();
  });

  test('rejects legacy accounts without an explicit connection association', async () => {
    bankAccountFindById.mockResolvedValueOnce(
      makeAccount({ connectionId: null })
    );

    await expect(
      resolveIngestionContext({
        bankAccountId: 'account-1',
        ingestionChannel: 'poll',
      })
    ).rejects.toThrow(/no current connection association/i);

    expect(bankConnectionFindById).not.toHaveBeenCalled();
  });

  test('requires account validation to be complete', async () => {
    bankAccountFindById.mockResolvedValueOnce(
      makeAccount({ validationStatus: 'pending' })
    );

    await expect(
      resolveIngestionContext({
        bankAccountId: 'account-1',
        ingestionChannel: 'poll',
      })
    ).rejects.toThrow(/not completed validation/i);
  });

  test('requires the current bank connection to be active', async () => {
    bankConnectionFindById.mockResolvedValueOnce(
      makeConnection({ status: 'pending' })
    );

    await expect(
      resolveIngestionContext({
        bankAccountId: 'account-1',
        ingestionChannel: 'poll',
      })
    ).rejects.toThrow(/not active/i);
  });

  test('rejects a connection belonging to another client', async () => {
    bankConnectionFindById.mockResolvedValueOnce(
      makeConnection({ clientId: 'another-client' })
    );

    await expect(
      resolveIngestionContext({
        bankAccountId: 'account-1',
        ingestionChannel: 'poll',
      })
    ).rejects.toThrow(/client does not match/i);
  });

  test('rejects a connection with a different provider', async () => {
    bankConnectionFindById.mockResolvedValueOnce(
      makeConnection({ provider: 'KCB' })
    );

    await expect(
      resolveIngestionContext({
        bankAccountId: 'account-1',
        ingestionChannel: 'poll',
      })
    ).rejects.toThrow(/provider does not match/i);
  });

  test.each([
    ['poll', 'poll'],
    ['statement', 'import'],
    ['webhook', 'webhook'],
  ])('%s authorization chooses trusted %s provenance, ignoring provider sourceChannel', async (
    ingestionChannel,
    expectedSourceChannel
  ) => {
    const result = await ingestNormalizedTransaction({
      bankAccount: account,
      connectionId: 'connection-current',
      ingestionChannel,
      normalized: makeNormalized({
        providerTransactionId: `txn-${ingestionChannel}`,
        sourceChannel: 'webhook',
      }),
      process: false,
    });

    const [created] = bankTransactionCreate.mock.calls[0];

    expect(created.sourceChannel).toBe(expectedSourceChannel);
    expect(created.connectionId).toBe('connection-current');
    expect(created.clientId).toBe('client-1');
    expect(created.estateId).toBe('estate-1');
    expect(created.bankAccountId).toBe('account-1');
    expect(result.created).toBe(true);
  });

  test('statement entitlement cannot authorize polling ingestion', async () => {
    account.entitlements = {
      poll: false,
      statement: true,
      webhookIngest: false,
    };

    await expect(
      resolveIngestionContext({
        bankAccountId: 'account-1',
        ingestionChannel: 'poll',
      })
    ).rejects.toThrow(/not entitled to poll ingestion/i);
  });

  test('poll entitlement cannot authorize statement ingestion', async () => {
    account.entitlements = {
      poll: true,
      statement: false,
      webhookIngest: false,
    };

    await expect(
      resolveIngestionContext({
        bankAccountId: 'account-1',
        ingestionChannel: 'statement',
      })
    ).rejects.toThrow(/not entitled to statement ingestion/i);
  });

  test('missing or unrecognized trusted channel fails closed', async () => {
    await expect(
      resolveIngestionContext({
        bankAccountId: 'account-1',
      })
    ).rejects.toThrow(/trusted ingestionChannel is required/i);

    await expect(
      resolveIngestionContext({
        bankAccountId: 'account-1',
        ingestionChannel: 'provider-says-webhook',
      })
    ).rejects.toThrow(/trusted ingestionChannel is required/i);
  });

  test('historical transaction processing does not require its old connection to remain current or active', async () => {
    const historical = {
      _id: 'historical-transaction',
      clientId: 'client-1',
      estateId: 'estate-1',
      bankAccountId: 'account-1',
      provider: 'COOP',
      providerTransactionId: 'old-provider-txn',
      connectionId: 'disconnected-old-connection',
      eventType: 'CREDIT',
      processingState: 'RECEIVED',
    };

    const claimed = {
      ...historical,
      processingState: 'CLAIMED',
      processingClaimToken: 'historical-worker-token',
    };
    const posted = {
      ...claimed,
      processingState: 'POSTED',
    };
    const finalDoc = {
      ...posted,
      processingClaimToken: null,
      processingClaimExpiresAt: null,
    };

    bankTransactionFindById
      .mockResolvedValueOnce(historical)
      .mockResolvedValueOnce(posted)
      .mockResolvedValueOnce(finalDoc);

    claimBankTransaction.mockResolvedValueOnce({
      claimed: true,
      doc: claimed,
      claimToken: 'historical-worker-token',
    });
    reconcile.mockResolvedValueOnce({ matched: true });

    const result = await processBankTransaction({
      _id: historical._id,
      // Deliberately stale caller fields must not replace persisted fields.
      connectionId: 'some-other-connection',
      eventType: 'DEBIT',
    });

    expect(bankTransactionFindById).toHaveBeenCalledWith(historical._id);
    expect(claimBankTransaction).toHaveBeenCalledWith(historical._id);
    expect(reconcile).toHaveBeenCalledWith(
      claimed,
      { claimToken: 'historical-worker-token' }
    );

    // Processing historical work is deliberately independent of current account/connection state.
    expect(bankAccountFindById).not.toHaveBeenCalled();
    expect(bankConnectionFindById).not.toHaveBeenCalled();

    expect(result.processed).toBe(true);
    expect(result.doc).toBe(finalDoc);
  });
});
