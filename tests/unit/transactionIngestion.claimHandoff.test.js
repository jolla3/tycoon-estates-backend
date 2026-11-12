import '../setup.js';
import { jest } from '@jest/globals';

const bankTransactionFindById = jest.fn();
const bankTransactionFindOneAndUpdate = jest.fn();
const claimBankTransaction = jest.fn();
const failClaim = jest.fn();
const reconcile = jest.fn();

jest.unstable_mockModule('../../src/models/BankTransaction.js', () => ({
  BankTransaction: {
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

const { processBankTransaction } = await import(
  '../../src/services/banking/transactionIngestion.service.js'
);

describe('G4 processing to G3 claim hand-off', () => {
  beforeEach(() => {
    bankTransactionFindById.mockReset();
    bankTransactionFindOneAndUpdate.mockReset();
    claimBankTransaction.mockReset();
    failClaim.mockReset();
    reconcile.mockReset();

    bankTransactionFindOneAndUpdate.mockResolvedValue(null);
    failClaim.mockResolvedValue(null);
  });

  test('passes the exact acquired claim token to G3 reconciliation', async () => {
    const input = {
      _id: 'txn-1',
      clientId: 'client-1',
      estateId: 'estate-1',
      bankAccountId: 'account-1',
      provider: 'COOP',
      providerTransactionId: 'provider-txn-1',
      connectionId: 'old-connection-after-reconnect',
      eventType: 'CREDIT',
      processingState: 'RECEIVED',
    };

    const claimedDoc = {
      ...input,
      processingState: 'CLAIMED',
      processingClaimToken: 'worker-token-1',
    };

    const postedDoc = {
      ...claimedDoc,
      processingState: 'POSTED',
      processingClaimToken: null,
      processingClaimExpiresAt: null,
    };

    const finalDoc = { ...postedDoc };

    claimBankTransaction.mockResolvedValue({
      claimed: true,
      doc: claimedDoc,
      claimToken: 'worker-token-1',
    });

    reconcile.mockResolvedValue({
      matched: true,
      bankTransaction: claimedDoc,
    });

    bankTransactionFindById
      .mockResolvedValueOnce(input)
      .mockResolvedValueOnce(postedDoc)
      .mockResolvedValueOnce(finalDoc);

    const result = await processBankTransaction(input);

    expect(claimBankTransaction).toHaveBeenCalledWith('txn-1');
    expect(reconcile).toHaveBeenCalledTimes(1);
    expect(reconcile).toHaveBeenCalledWith(
      claimedDoc,
      { claimToken: 'worker-token-1' }
    );

    // G3 may already have consumed the claim. The follow-up cleanup must
    // still be scoped to the original token and cannot clear a newer claim.
    expect(bankTransactionFindOneAndUpdate).toHaveBeenCalledWith(
      expect.objectContaining({
        _id: 'txn-1',
        processingClaimToken: 'worker-token-1',
      }),
      expect.any(Object)
    );

    expect(result.processed).toBe(true);
    expect(result.doc).toBe(finalDoc);
  });

  test('does not call G3 when claim acquisition fails', async () => {
    const input = {
      _id: 'txn-2',
      clientId: 'client-1',
      estateId: 'estate-1',
      bankAccountId: 'account-1',
      provider: 'COOP',
      providerTransactionId: 'provider-txn-2',
      connectionId: 'old-connection-after-reconnect',
      eventType: 'CREDIT',
      processingState: 'RECEIVED',
    };

    claimBankTransaction.mockResolvedValue({
      claimed: false,
      doc: { ...input, processingState: 'CLAIMED' },
      claimToken: null,
    });

    bankTransactionFindById.mockResolvedValueOnce(input);

    const result = await processBankTransaction(input);

    expect(reconcile).not.toHaveBeenCalled();
    expect(bankTransactionFindById).toHaveBeenCalledWith('txn-2');
    expect(result.processed).toBe(false);
    expect(result.reason).toBe('not_claimed');
  });

  test('does not clear a newer owner claim after G3 reports an error', async () => {
    const input = {
      _id: 'txn-3',
      clientId: 'client-1',
      estateId: 'estate-1',
      bankAccountId: 'account-1',
      provider: 'COOP',
      providerTransactionId: 'provider-txn-3',
      connectionId: 'old-connection-after-reconnect',
      eventType: 'CREDIT',
      processingState: 'RECEIVED',
    };

    const claimedDoc = {
      ...input,
      processingState: 'CLAIMED',
    };

    claimBankTransaction.mockResolvedValue({
      claimed: true,
      doc: claimedDoc,
      claimToken: 'old-worker-token',
    });

    reconcile.mockRejectedValue(new Error('claim expired or replaced'));
    bankTransactionFindById.mockResolvedValueOnce(input);

    const result = await processBankTransaction(input);

    expect(failClaim).toHaveBeenCalledWith(
      'txn-3',
      'old-worker-token',
      expect.objectContaining({
        terminal: false,
      })
    );
    expect(result.processed).toBe(false);
    expect(result.reason).toBe('reconcile_error');
  });
});
