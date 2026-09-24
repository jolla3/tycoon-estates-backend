// src/utils/redisWithTimeout.js
//
// With maxRetriesPerRequest: null (config/redis.js), a Redis command
// issued while Redis is unreachable queues indefinitely instead of
// rejecting — good for not crashing the process, bad for a request that
// would otherwise hang forever waiting for a command that may never
// complete. This wraps a Redis call with a hard timeout so callers can
// fail open (e.g. "treat as not rate-limited") instead of hanging.
export function withRedisTimeout(promise, ms = 250) {
  return Promise.race([
    promise,
    new Promise((_, reject) => setTimeout(() => reject(new Error('redis_timeout')), ms)),
  ]);
}
