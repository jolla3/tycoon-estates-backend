import '../setup.js';
import { jest } from '@jest/globals';

const findOneAndUpdate = jest.fn();
const findById = jest.fn();

jest.unstable_mockModule('../../src/models/BankTransaction.js', () => ({
  BankTransaction: {
    findOneAndUpdate,
    findById,
  },
}));

const {
  claimBankTransaction,
  completeClaim,
  failClaim,
  markManualReview,
} = await import('../../src/services/banking/processingClaim.js');

function collectObjects(value, output = []) {
  if (value === null || typeof value !== 'object') return output;

  output.push(value);

  if (Array.isArray(value)) {
    for (const item of value) collectObjects(item, output);
  } else {
    for (const item of Object.values(value)) collectObjects(item, output);
  }

  return output;
}

describe('processing claim ownership contract', () => {
  beforeEach(() => {
    findOneAndUpdate.mockReset();
    findById.mockReset();

    findOneAndUpdate.mockResolvedValue(null);
    findById.mockResolvedValue({
      _id: 'txn-1',
      processingState: 'CLAIMED',
    });
  });

  test('expired CLAIMED transactions are eligible for atomic takeover', async () => {
    await claimBankTransaction('txn-1', {
      claimToken: 'replacement-token',
      ttlMs: 60_000,
    });

    const [filter, update] = findOneAndUpdate.mock.calls[0];
    const hasExpiredClaimBranch = collectObjects(filter).some((node) => {
      const states = Array.isArray(node.processingState?.$in)
        ? node.processingState.$in
        : [node.processingState];

      return states.includes('CLAIMED')
        && node.processingClaimExpiresAt?.$lte instanceof Date;
    });

    expect(hasExpiredClaimBranch).toBe(true);
    expect(update.$set.processingClaimToken).toBe('replacement-token');
    expect(update.$set.processingClaimExpiresAt).toBeInstanceOf(Date);
    expect(update.$inc.processingAttempts).toBe(1);
  });

  test('completion requires an unexpired claim', async () => {
    await completeClaim('txn-1', 'active-token');

    const [filter] = findOneAndUpdate.mock.calls[0];

    expect(filter.processingClaimToken).toBe('active-token');
    expect(filter.processingState).toBe('CLAIMED');
    expect(filter.processingClaimExpiresAt?.$gt).toBeInstanceOf(Date);
  });

  test('failure requires an unexpired claim', async () => {
    await failClaim('txn-1', 'active-token', {
      errorMessage: 'temporary failure',
    });

    const [filter] = findOneAndUpdate.mock.calls[0];

    expect(filter.processingClaimToken).toBe('active-token');
    expect(filter.processingState).toBe('CLAIMED');
    expect(filter.processingClaimExpiresAt?.$gt).toBeInstanceOf(Date);
  });

  test('unclaimed manual-review transition cannot take over a CLAIMED transaction', async () => {
    await markManualReview('txn-1', null, 'unmatched');

    const [filter] = findOneAndUpdate.mock.calls[0];
    const allowedStates = filter.processingState?.$in || [];

    expect(allowedStates).not.toContain('CLAIMED');
  });
});
