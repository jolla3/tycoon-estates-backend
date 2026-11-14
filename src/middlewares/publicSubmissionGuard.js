// src/middlewares/publicSubmissionGuard.js — abuse controls for the unauthenticated
// Tenant submission endpoint. Unlike the general limiter (fail-open on Redis errors),
// this FAILS CLOSED to a per-process counter, so a Redis outage can only make the limit
// stricter (per instance), never remove it.
import { getRedisClient } from '../config/redis.js';
import { withRedisTimeout } from '../utils/redisWithTimeout.js';

const local = new Map(); // key -> { n, resetAt }
let lastSweep = 0;

function localHit(key, windowMs) {
  const now = Date.now();
  if (now - lastSweep > 60_000) {
    for (const [k, v] of local) if (v.resetAt <= now) local.delete(k);
    lastSweep = now;
  }
  const cur = local.get(key);
  if (!cur || cur.resetAt <= now) { local.set(key, { n: 1, resetAt: now + windowMs }); return 1; }
  cur.n += 1;
  return cur.n;
}

export async function hit(key, windowMs) {
  try {
    const r = getRedisClient();
    const n = await withRedisTimeout(r.incr(`g5pub:${key}`));
    if (n === 1) await withRedisTimeout(r.pexpire(`g5pub:${key}`, windowMs));
    return n;
  } catch {
    return localHit(key, windowMs);
  }
}

export const LIMITS = { perIp: { windowMs: 10 * 60_000, max: 20 }, global: { windowMs: 60_000, max: 600 } };

export async function publicSubmissionGuard(req, res, next) {
  res.set({
    'Cache-Control': 'no-store',
    Pragma: 'no-cache',
    'Referrer-Policy': 'no-referrer',
    'Content-Security-Policy': "default-src 'none'; frame-ancestors 'none'",
    'X-Content-Type-Options': 'nosniff',
  });
  const ip = req.ip || 'unknown';
  const [a, b] = await Promise.all([
    hit(`ip:${ip}`, LIMITS.perIp.windowMs),
    hit('global', LIMITS.global.windowMs),
  ]);
  if (a > LIMITS.perIp.max || b > LIMITS.global.max) {
    return res.status(429).json({ success: false, error: { code: 'RATE_LIMITED', message: 'Too many requests' } });
  }
  return next();
}
