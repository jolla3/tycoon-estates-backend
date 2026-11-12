import '../setup.js';
import { jest } from '@jest/globals';

const findOneAndUpdate = jest.fn();
const findById = jest.fn();

jest.unstable_mockModule('../../src/models/BankAccount.js', () => ({
  BankAccount: {
    findOneAndUpdate,
    findById,
  },
}));

const {
  acquireSyncLease,
  advanceCheckpoint,
  failSyncLease,
  releaseSyncLease,
  extendSyncLease,
} = await import('../../src/services/banking/syncCoordination.service.js');

describe('sync lease fencing query contracts', () => {
  beforeEach(() => {
    findOneAndUpdate.mockReset();
    findById.mockReset();
    findOneAndUpdate.mockResolvedValue(null);
  });

  test('acquisition does not allow the current worker to reacquire an active lease', async () => {
    findOneAndUpdate.mockResolvedValue({
      sync: {
        fenceGeneration: 8,
        leaseExpiresAt: new Date(Date.now() + 60_000),
      },
    });

    await acquireSyncLease('account-1', {
      workerId: 'worker-1',
      ttlMs: 60_000,
    });

    const [filter] = findOneAndUpdate.mock.calls[0];

    expect(filter._id).toBe('account-1');
    expect(filter.$or).toHaveLength(2);
    expect(filter.$or[0]).toEqual({
      'sync.leaseExpiresAt': null,
      'sync.leaseOwner': null,
    });
    expect(filter.$or[1]['sync.leaseExpiresAt'].$lte).toBeInstanceOf(Date);
    expect(
      filter.$or.some((branch) => branch['sync.leaseOwner'] === 'worker-1')
    ).toBe(false);
  });

  test('every lease mutation requires owner, generation and an unexpired lease', async () => {
    const operations = [
      () => advanceCheckpoint('account-1', {
        workerId: 'worker-1',
        fenceGeneration: 4,
        checkpoint: { type: 'none', value: null },
      }),
      () => failSyncLease('account-1', {
        workerId: 'worker-1',
        fenceGeneration: 4,
        errorMessage: 'test failure',
      }),
      () => releaseSyncLease('account-1', {
        workerId: 'worker-1',
        fenceGeneration: 4,
      }),
      () => extendSyncLease('account-1', {
        workerId: 'worker-1',
        fenceGeneration: 4,
      }),
    ];

    for (const operation of operations) {
      findOneAndUpdate.mockClear();
      await operation();

      expect(findOneAndUpdate).toHaveBeenCalledTimes(1);
      const [filter] = findOneAndUpdate.mock.calls[0];

      expect(filter._id).toBe('account-1');
      expect(filter['sync.leaseOwner']).toBe('worker-1');
      expect(filter['sync.fenceGeneration']).toBe(4);
      expect(filter['sync.leaseExpiresAt'].$gt).toBeInstanceOf(Date);
    }
  });
});
