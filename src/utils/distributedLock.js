// src/utils/distributedLock.js
//
// Section 30 (V2): a minimal Redis-based lock so background jobs stay
// safe when multiple API/worker instances run the same setInterval loop
// simultaneously — only one instance actually executes a given job per
// tick; the rest skip it. This is NOT a general-purpose distributed lock
// (no re-entrancy, no queueing) — it's specifically "at most one runner
// per interval", which is exactly what section 30 requires and no more
// (section 41: don't over-engineer).

import crypto from 'crypto';
import { getRedisClient } from '../config/redis.js';
import { logger } from '../config/logger.js';

/**
 * Attempts to acquire `key` for `ttlMs`. Returns a release() function if
 * acquired, or null if another instance already holds it.
 */
export async function tryAcquireLock(key, ttlMs) {
  const redis = getRedisClient();
  const token = crypto.randomBytes(8).toString('hex');

  const acquired = await redis.set(key, token, 'PX', ttlMs, 'NX');
  if (!acquired) return null;

  return async function release() {
    // Only release if we still hold it (avoid releasing a lock some
    // OTHER instance has since acquired after our TTL expired).
    const luaScript = `
      if redis.call("get", KEYS[1]) == ARGV[1] then
        return redis.call("del", KEYS[1])
      else
        return 0
      end
    `;
    try {
      await redis.eval(luaScript, 1, key, token);
    } catch (err) {
      logger.warn({ key, error: err.message }, 'Failed to release distributed lock (will expire via TTL)');
    }
  };
}

/** Runs fn() only if the lock is acquired; otherwise logs and skips. Always releases afterward. */
export async function withLock(key, ttlMs, fn) {
  const release = await tryAcquireLock(key, ttlMs);
  if (!release) {
    logger.debug({ key }, 'Skipping job tick — another instance holds the lock');
    return { ran: false };
  }
  try {
    await fn();
    return { ran: true };
  } finally {
    await release();
  }
}
