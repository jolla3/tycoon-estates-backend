// src/config/redis.js
//
// Section 28/29/30 (V2): Redis backs rate limiting and distributed job
// locks across multiple API instances — it is NEVER the source of truth
// for financial data, which stays in MongoDB.
//
// Sessions deliberately stay on the MongoDB-backed store already in
// app.js (connect-mongo) rather than moving to Redis too — one
// horizontally-safe session store is enough, and MongoDB is already the
// durable store this project depends on operationally.

import Redis from 'ioredis';
import { env, isProduction } from './environment.js';
import { logger } from './logger.js';
import { withRedisTimeout } from '../utils/redisWithTimeout.js';

let client = null;
let lastPingOk = false;
let lastPingAt = null;
let lastPingError = null;

export function getRedisClient() {
  if (client) return client;

  client = new Redis(env.REDIS_URL, {
    // Commands issued while disconnected queue and wait for reconnection
    // rather than throwing after N retries — an unawaited rejected
    // command promise (e.g. from a library's internal script
    // registration) becomes an unhandled rejection that crashes the
    // whole process (reproduced during testing). Queuing is safer for
    // data Redis is deliberately NOT the source of truth for (section 28)
    // — but see utils/redisWithTimeout.js for why callers still need a
    // bounded timeout on top of this: an indefinitely-queued command
    // would otherwise hang a request forever during a real Redis outage.
    maxRetriesPerRequest: null,
    enableOfflineQueue: true,
    lazyConnect: false,
    retryStrategy: (times) => Math.min(times * 200, 5000),
  });

  client.on('error', (err) => {
    lastPingOk = false;
    lastPingError = err.message;
    logger.error({ error: err.message }, 'Redis connection error');
  });
  client.on('connect', () => logger.info('Connected to Redis'));
  client.on('ready', () => {
    lastPingOk = true;
    lastPingError = null;
    logger.info('Redis ready');
  });
  client.on('close', () => {
    lastPingOk = false;
    logger.warn('Redis connection closed');
  });

  return client;
}

/**
 * Bounded readiness check: issues a real PING and records latency.
 * Never hangs indefinitely — uses withRedisTimeout.
 * Does NOT expose REDIS_URL or credentials.
 */
export async function checkRedisHealth(timeoutMs = 500) {
  const started = Date.now();
  try {
    const redis = getRedisClient();
    const pong = await withRedisTimeout(redis.ping(), timeoutMs);
    const latencyMs = Date.now() - started;
    const ok = pong === 'PONG';
    lastPingOk = ok;
    lastPingAt = new Date();
    lastPingError = ok ? null : `unexpected PING response: ${pong}`;
    return {
      status: ok ? 'healthy' : 'unhealthy',
      latencyMs,
      lastCheckAt: lastPingAt.toISOString(),
    };
  } catch (err) {
    lastPingOk = false;
    lastPingAt = new Date();
    lastPingError = err.message;
    return {
      status: 'unhealthy',
      latencyMs: Date.now() - started,
      lastCheckAt: lastPingAt.toISOString(),
      error: err.message === 'redis_timeout' ? 'timeout' : 'unreachable',
    };
  }
}

/** Synchronous snapshot used by /ready when a live PING is not required. */
export function isRedisReady() {
  if (!client) return false;
  // ioredis status: 'ready' means connected and ready to accept commands
  return client.status === 'ready' && lastPingOk;
}

/**
 * Startup gate: wait until Redis answers PING, or fail within timeout.
 * In production this is a hard requirement (rate limits + job locks).
 * In development we log a warning and continue so local work is not blocked
 * when Redis is temporarily unavailable — readiness endpoint still reports truth.
 */
export async function ensureRedisReady({ timeoutMs = 5000, intervalMs = 250 } = {}) {
  getRedisClient();
  const deadline = Date.now() + timeoutMs;

  while (Date.now() < deadline) {
    const result = await checkRedisHealth(Math.min(400, timeoutMs));
    if (result.status === 'healthy') {
      logger.info({ latencyMs: result.latencyMs }, 'Redis PING ok — ready');
      return true;
    }
    await new Promise((r) => setTimeout(r, intervalMs));
  }

  if (isProduction) {
    throw new Error(
      `[redis] Redis did not become ready within ${timeoutMs}ms. ` +
        `Rate limiting and distributed job locks require Redis in production. ` +
        `Last error: ${lastPingError || 'unknown'}`
    );
  }

  logger.warn(
    { lastError: lastPingError },
    'Redis not ready at startup — continuing in development (readiness will report unhealthy)'
  );
  return false;
}

export function getRedisStatusSnapshot() {
  return {
    status: isRedisReady() ? 'healthy' : 'unhealthy',
    lastCheckAt: lastPingAt ? lastPingAt.toISOString() : null,
    // Never expose URL, password, or connection string
  };
}

export async function disconnectRedis() {
  if (client) {
    await client.quit();
    client = null;
    lastPingOk = false;
  }
}
