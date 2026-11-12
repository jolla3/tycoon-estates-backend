import '../setup.js';
import { jest } from '@jest/globals';

const account = {
  _id: 'account-1',
  clientId: 'client-1',
  estateId: 'estate-1',
  provider: 'COOP',
  connectionStatus: 'connected',
  validationStatus: 'validated',
  connectionId: 'connection-1',
  entitlements: { poll: true, statement: false, webhookIngest: false },
  sync: { checkpoint: { type: 'none', value: null } },
};

const bankAccountFindOne = jest.fn();
const connectionGet = jest.fn();
const activeConnection = {
  _id: 'connection-1',
  clientId: 'client-1',
  provider: 'COOP',
  status: 'active',
  credentialsRef: 'secret-ref-v3',
  credentialVersion: 3,
};
const getAdapterForConnection = jest.fn();
const createCoopSyncStrategy = jest.fn();
const strategy = {
  supportsOperationalSync: jest.fn(),
  begin: jest.fn(),
  fetchPage: jest.fn(),
};
const getBankProviderCapabilities = jest.fn();
const acquireSyncLease = jest.fn();
const extendSyncLease = jest.fn();
const advanceCheckpoint = jest.fn();
const failSyncLease = jest.fn();
const releaseSyncLease = jest.fn();
const ingestNormalizedTransactionBatch = jest.fn();
const audit = jest.fn();
const loggerWarn = jest.fn();

jest.unstable_mockModule('../../src/models/BankAccount.js', () => ({
  BankAccount: { findOne: bankAccountFindOne },
}));

jest.unstable_mockModule('../../src/services/connection.service.js', () => ({
  connectionService: {
    get: connectionGet,
    getAdapterForConnection,
  },
}));

jest.unstable_mockModule(
  '../../src/services/banking/providers/coop/coop.syncStrategy.js',
  () => ({ createCoopSyncStrategy })
);

jest.unstable_mockModule(
  '../../src/services/banking/syncCoordination.service.js',
  () => ({
    acquireSyncLease,
    extendSyncLease,
    advanceCheckpoint,
    failSyncLease,
    releaseSyncLease,
    newSyncWorkerId: () => 'generated-worker',
  })
);

jest.unstable_mockModule(
  '../../src/services/banking/transactionIngestion.service.js',
  () => ({ ingestNormalizedTransactionBatch })
);

jest.unstable_mockModule('../../src/services/banking/bank.factory.js', () => ({
  getBankProviderCapabilities,
}));

jest.unstable_mockModule('../../src/services/audit.service.js', () => ({
  audit,
}));

jest.unstable_mockModule('../../src/config/logger.js', () => ({
  logger: {
    warn: loggerWarn,
    error: jest.fn(),
    info: jest.fn(),
  },
}));

const { synchronizeBankAccount } = await import(
  '../../src/services/banking/bankSync.service.js'
);

describe('bank sync lease-loss orchestration', () => {
  beforeEach(() => {
    bankAccountFindOne.mockReset();
    connectionGet.mockReset();
    getAdapterForConnection.mockReset();
    createCoopSyncStrategy.mockReset();
    strategy.supportsOperationalSync.mockReset();
    strategy.begin.mockReset();
    strategy.fetchPage.mockReset();
    getBankProviderCapabilities.mockReset();
    acquireSyncLease.mockReset();
    extendSyncLease.mockReset();
    advanceCheckpoint.mockReset();
    failSyncLease.mockReset();
    releaseSyncLease.mockReset();
    ingestNormalizedTransactionBatch.mockReset();
    audit.mockReset();
    loggerWarn.mockReset();

    bankAccountFindOne.mockResolvedValue(account);
    connectionGet.mockResolvedValue(activeConnection);
    getAdapterForConnection.mockResolvedValue({
      adapter: true,
      connectionId: 'connection-1',
      credentialVersion: 3,
    });
    createCoopSyncStrategy.mockReturnValue(strategy);
    strategy.supportsOperationalSync.mockReturnValue(true);
    strategy.begin.mockResolvedValue({ session: true });
    strategy.fetchPage.mockResolvedValue({
      items: [{ providerTransactionId: 'provider-txn-1' }],
      exhausted: true,
      checkpointCandidate: {
        type: 'date_window',
        value: { end: '2026-11-11' },
        acceptedThrough: new Date('2026-11-11T00:00:00.000Z'),
      },
    });
    getBankProviderCapabilities.mockReturnValue({ implemented: true, operationalReady: true });
    acquireSyncLease.mockResolvedValue({ fenceGeneration: 5 });
    extendSyncLease.mockResolvedValue(true);
    advanceCheckpoint.mockResolvedValue(true);
    failSyncLease.mockResolvedValue(true);
    releaseSyncLease.mockResolvedValue(true);
    ingestNormalizedTransactionBatch.mockResolvedValue({
      stored: 1,
      processed: 1,
      results: [{ ok: true }],
    });
    audit.mockResolvedValue(undefined);
  });

  test('statement entitlement alone authorizes the COOP FullStatement worker', async () => {
    bankAccountFindOne.mockResolvedValue({
      ...account,
      entitlements: { poll: false, statement: true },
    });

    await synchronizeBankAccount(
      'client-1',
      'account-1',
      { workerId: 'worker-1' }
    );

    expect(acquireSyncLease).toHaveBeenCalledTimes(1);
    expect(strategy.fetchPage).toHaveBeenCalledTimes(1);
    expect(ingestNormalizedTransactionBatch).toHaveBeenCalledTimes(1);
  });

  test('does not fetch when the connection becomes inactive before a page', async () => {
    connectionGet
      .mockResolvedValueOnce(activeConnection)
      .mockResolvedValueOnce({
        ...activeConnection,
        status: 'reauth_required',
      });

    await expect(
      synchronizeBankAccount('client-1', 'account-1', { workerId: 'worker-1' })
    ).rejects.toThrow(/no longer active/i);

    expect(strategy.fetchPage).not.toHaveBeenCalled();
    expect(ingestNormalizedTransactionBatch).not.toHaveBeenCalled();
    expect(advanceCheckpoint).not.toHaveBeenCalled();
  });

  test('rejects a fetched page when the connection is disconnected during provider fetch', async () => {
    connectionGet
      .mockResolvedValueOnce(activeConnection)
      .mockResolvedValueOnce(activeConnection)
      .mockResolvedValueOnce({
        ...activeConnection,
        status: 'disconnected',
      });

    await expect(
      synchronizeBankAccount('client-1', 'account-1', { workerId: 'worker-1' })
    ).rejects.toThrow(/no longer active/i);

    expect(strategy.fetchPage).toHaveBeenCalledTimes(1);
    expect(ingestNormalizedTransactionBatch).not.toHaveBeenCalled();
    expect(advanceCheckpoint).not.toHaveBeenCalled();
    expect(audit).not.toHaveBeenCalled();
  });

  test('rejects a fetched page when credentials rotate during provider fetch', async () => {
    connectionGet
      .mockResolvedValueOnce(activeConnection)
      .mockResolvedValueOnce(activeConnection)
      .mockResolvedValueOnce({
        ...activeConnection,
        credentialsRef: 'secret-ref-v4',
        credentialVersion: 4,
      });

    await expect(
      synchronizeBankAccount('client-1', 'account-1', { workerId: 'worker-1' })
    ).rejects.toThrow(/credentials rotated/i);

    expect(strategy.fetchPage).toHaveBeenCalledTimes(1);
    expect(ingestNormalizedTransactionBatch).not.toHaveBeenCalled();
    expect(advanceCheckpoint).not.toHaveBeenCalled();
  });

  test('rejects a fetched page when the bank account is reassigned during provider fetch', async () => {
    bankAccountFindOne
      .mockResolvedValueOnce(account)
      .mockResolvedValueOnce(account)
      .mockResolvedValueOnce({
        ...account,
        connectionId: 'replacement-connection',
      });

    await expect(
      synchronizeBankAccount('client-1', 'account-1', { workerId: 'worker-1' })
    ).rejects.toThrow(/association changed/i);

    expect(strategy.fetchPage).toHaveBeenCalledTimes(1);
    expect(ingestNormalizedTransactionBatch).not.toHaveBeenCalled();
    expect(advanceCheckpoint).not.toHaveBeenCalled();
  });

  test('stops before fetching when the initial heartbeat fails', async () => {
    extendSyncLease.mockResolvedValueOnce(false);

    const result = await synchronizeBankAccount(
      'client-1',
      'account-1',
      { workerId: 'worker-1' }
    );

    expect(result).toMatchObject({
      ok: false,
      reason: 'lease_lost_before_fetch',
      checkpointAdvanced: false,
    });
    expect(strategy.fetchPage).not.toHaveBeenCalled();
    expect(ingestNormalizedTransactionBatch).not.toHaveBeenCalled();
    expect(advanceCheckpoint).not.toHaveBeenCalled();
    expect(audit).not.toHaveBeenCalled();
  });

  test('stops before ingestion when the lease is lost during provider fetch', async () => {
    extendSyncLease
      .mockResolvedValueOnce(true)
      .mockResolvedValueOnce(false);

    const result = await synchronizeBankAccount(
      'client-1',
      'account-1',
      { workerId: 'worker-1' }
    );

    expect(result).toMatchObject({
      ok: false,
      reason: 'lease_lost_after_fetch',
      checkpointAdvanced: false,
    });
    expect(strategy.fetchPage).toHaveBeenCalledTimes(1);
    expect(ingestNormalizedTransactionBatch).not.toHaveBeenCalled();
    expect(advanceCheckpoint).not.toHaveBeenCalled();
    expect(audit).not.toHaveBeenCalled();
  });

  test('does not report success or emit a success audit when checkpoint fencing fails', async () => {
    advanceCheckpoint.mockResolvedValue(false);

    const result = await synchronizeBankAccount(
      'client-1',
      'account-1',
      { workerId: 'worker-1' }
    );

    expect(ingestNormalizedTransactionBatch).toHaveBeenCalledTimes(1);
    expect(advanceCheckpoint).toHaveBeenCalledTimes(1);
    expect(result).toMatchObject({
      ok: false,
      reason: 'lease_lost_checkpoint',
      checkpointAdvanced: false,
    });
    expect(releaseSyncLease).not.toHaveBeenCalled();
    expect(audit).not.toHaveBeenCalled();
  });

  test('reports success only after the checkpoint is accepted', async () => {
    const result = await synchronizeBankAccount(
      'client-1',
      'account-1',
      { workerId: 'worker-1' }
    );

    expect(extendSyncLease).toHaveBeenCalledTimes(2);
    expect(ingestNormalizedTransactionBatch).toHaveBeenCalledTimes(1);
    expect(ingestNormalizedTransactionBatch.mock.calls[0][2]).toMatchObject({
      ingestionChannel: 'poll',
      connectionId: 'connection-1',
      expectedCredentialVersion: 3,
    });
    expect(advanceCheckpoint).toHaveBeenCalledTimes(1);
    expect(result).toMatchObject({
      ok: true,
      checkpointAdvanced: true,
    });
    expect(releaseSyncLease).toHaveBeenCalledTimes(1);
    expect(audit).toHaveBeenCalledTimes(1);
    expect(audit.mock.calls[0][0].metadata.checkpointAdvanced).toBe(true);
  });
});
