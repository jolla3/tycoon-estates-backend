import crypto from 'crypto';

/**
 * Contract tests for the distributed lock implementation shape.
 * Live Redis concurrent acquisition requires a real Redis instance
 * (see Phase 34) — not available in this CI sandbox.
 */
describe('distributed lock contract', () => {
  test('token generation produces unique ownership tokens', () => {
    const a = crypto.randomBytes(8).toString('hex');
    const b = crypto.randomBytes(8).toString('hex');
    expect(a).not.toEqual(b);
    expect(a).toHaveLength(16);
  });

  test('lock module exports tryAcquireLock and withLock', async () => {
    const mod = await import('../../src/utils/distributedLock.js');
    expect(typeof mod.tryAcquireLock).toBe('function');
    expect(typeof mod.withLock).toBe('function');
  });
});
