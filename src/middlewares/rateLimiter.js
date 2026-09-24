// src/middlewares/rateLimiter.js
//
// Section 25/29/38: protects auth, webhook, and SMS endpoints from abuse,
// backed by Redis so limits are shared across every API instance behind
// the load balancer (an in-memory store would let each instance track
// its own counters, silently multiplying the effective limit by the
// instance count — section 29's "avoid in-memory... state" applies to
// rate-limit counters too, not just sessions/locks).
//
// This is a small hand-rolled fixed-window counter store rather than the
// `rate-limit-redis` package: testing that package's default Lua-script
// based increment against an unreachable Redis produced an unhandled
// promise rejection that crashed the whole process outright (not just
// the rate-limited request) — a single Redis blip taking down the API is
// worse than under- or over-limiting for a few seconds. This store fails
// OPEN (allows the request, logs a warning) on any Redis error or
// timeout, with each command bounded so a request can never hang
// indefinitely waiting on a Redis that isn't coming back soon.

import rateLimit from 'express-rate-limit';
import { getRedisClient } from '../config/redis.js';
import { withRedisTimeout } from '../utils/redisWithTimeout.js';
import { apiResponse } from '../utils/apiResponse.js';
import { logger } from '../config/logger.js';

function handler(req, res) {
  return apiResponse.error(res, 'RATE_LIMITED', 'Too many requests, please try again later', 429);
}

class FailOpenRedisStore {
  constructor(prefix, windowMs) {
    this.prefix = prefix;
    this.windowMs = windowMs;
  }

  async increment(key) {
    const redisKey = `rl:${this.prefix}:${key}`;
    try {
      const redis = getRedisClient();
      const count = await withRedisTimeout(redis.incr(redisKey));
      if (count === 1) {
        await withRedisTimeout(redis.pexpire(redisKey, this.windowMs)).catch(() => {});
      }
      return { totalHits: count, resetTime: new Date(Date.now() + this.windowMs) };
    } catch (err) {
      logger.warn({ error: err.message, redisKey }, 'Rate limiter Redis call failed — failing open for this request');
      return { totalHits: 1, resetTime: new Date(Date.now() + this.windowMs) };
    }
  }

  async decrement(key) {
    try {
      await withRedisTimeout(getRedisClient().decr(`rl:${this.prefix}:${key}`));
    } catch (_err) {
      /* fail-open: best-effort only */
    }
  }

  async resetKey(key) {
    try {
      await withRedisTimeout(getRedisClient().del(`rl:${this.prefix}:${key}`));
    } catch (_err) {
      /* fail-open: best-effort only */
    }
  }
}

function makeLimiter({ windowMs, max, prefix }) {
  return rateLimit({ windowMs, max, standardHeaders: true, legacyHeaders: false, handler, store: new FailOpenRedisStore(prefix, windowMs) });
}

export const authRateLimiter = makeLimiter({ windowMs: 15 * 60 * 1000, max: 20, prefix: 'auth' });
export const webhookRateLimiter = makeLimiter({ windowMs: 60 * 1000, max: 120, prefix: 'webhook' });
export const smsRateLimiter = makeLimiter({ windowMs: 60 * 1000, max: 60, prefix: 'sms' });
export const generalApiRateLimiter = makeLimiter({ windowMs: 60 * 1000, max: 300, prefix: 'api' });
