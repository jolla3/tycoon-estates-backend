// src/jobs/jobMetrics.js
// Operational telemetry only — not financial truth.

import { getRedisClient } from '../config/redis.js';
import { withRedisTimeout } from '../utils/redisWithTimeout.js';
import { logger } from '../config/logger.js';

const memory = new Map();

function key(name) {
  return `job-metrics:${name}`;
}

export async function recordJobStart(name) {
  const prev = memory.get(name) || {};
  const entry = {
    name,
    status: 'running',
    lastRunAt: new Date().toISOString(),
    lastSuccessAt: prev.lastSuccessAt || null,
    lastFailureAt: prev.lastFailureAt || null,
    lastError: prev.lastError || null,
    intervalMs: prev.intervalMs || null,
  };
  memory.set(name, entry);
  try {
    await withRedisTimeout(getRedisClient().set(key(name), JSON.stringify(entry), 'EX', 86400 * 7));
  } catch (err) {
    logger.debug({ job: name, error: err.message }, 'job metrics redis write failed');
  }
}

export async function recordJobSuccess(name, intervalMs) {
  const prev = memory.get(name) || { name };
  const now = new Date();
  const entry = {
    ...prev,
    name,
    status: 'idle',
    lastSuccessAt: now.toISOString(),
    lastError: null,
    intervalMs: intervalMs ?? prev.intervalMs ?? null,
    nextScheduledRunAt:
      intervalMs != null ? new Date(now.getTime() + intervalMs).toISOString() : prev.nextScheduledRunAt || null,
  };
  memory.set(name, entry);
  try {
    await withRedisTimeout(getRedisClient().set(key(name), JSON.stringify(entry), 'EX', 86400 * 7));
  } catch (_err) {
    /* ignore */
  }
}

export async function recordJobFailure(name, errorMessage, intervalMs) {
  const prev = memory.get(name) || { name };
  const now = new Date();
  const entry = {
    ...prev,
    name,
    status: 'idle',
    lastFailureAt: now.toISOString(),
    lastError: String(errorMessage || 'unknown').slice(0, 500),
    intervalMs: intervalMs ?? prev.intervalMs ?? null,
    nextScheduledRunAt:
      intervalMs != null ? new Date(now.getTime() + intervalMs).toISOString() : prev.nextScheduledRunAt || null,
  };
  memory.set(name, entry);
  try {
    await withRedisTimeout(getRedisClient().set(key(name), JSON.stringify(entry), 'EX', 86400 * 7));
  } catch (_err) {
    /* ignore */
  }
}

export const JOB_OUTCOME = Object.freeze({
  SUCCESS: 'SUCCESS', PARTIAL_FAILURE: 'PARTIAL_FAILURE', FAILED: 'FAILED',
  SKIPPED: 'SKIPPED', BLOCKED: 'BLOCKED', RUNNING: 'RUNNING',
});

const num = (v) => (Number.isFinite(v) ? v : 0);

/**
 * Classifies a job's returned summary into a typed outcome. Jobs that report no counts are
 * SUCCESS only in the sense "completed without throwing"; counts are then reported as null
 * rather than invented.
 */
export function classifyJobResult(result) {
  if (result == null || typeof result !== 'object') {
    return { outcome: JOB_OUTCOME.SUCCESS, counts: null, reason: null };
  }
  if (result.ran === false) {
    return { outcome: JOB_OUTCOME.SKIPPED, counts: null, reason: String(result.reason || 'skipped').slice(0, 100) };
  }
  const counts = {
    attempted: num(result.attempted), successful: num(result.successful),
    skipped: num(result.skipped), failed: num(result.failed), blocked: num(result.blocked),
  };
  let outcome = JOB_OUTCOME.SUCCESS;
  if (counts.failed > 0) {
    outcome = counts.successful > 0 || counts.attempted > counts.failed ? JOB_OUTCOME.PARTIAL_FAILURE : JOB_OUTCOME.FAILED;
  } else if (counts.blocked > 0 && counts.attempted === 0) {
    outcome = JOB_OUTCOME.BLOCKED;
  } else if (counts.blocked > 0) {
    outcome = JOB_OUTCOME.PARTIAL_FAILURE;
  }
  const clients = Array.isArray(result.clients) ? result.clients.slice(0, 50) : undefined;
  return { outcome, counts, reason: null, ...(clients ? { clients } : {}) };
}

/** Persists the typed outcome of the most recent completed run (operational telemetry only). */
export async function recordJobOutcome(name, outcomeInfo) {
  const prev = memory.get(name) || { name };
  const entry = { ...prev, name, lastOutcome: outcomeInfo };
  memory.set(name, entry);
  try {
    await withRedisTimeout(getRedisClient().set(key(name), JSON.stringify(entry), 'EX', 86400 * 7));
  } catch (_err) {
    /* ignore */
  }
}

export async function getJobMetrics(names, intervals = {}) {
  const out = [];
  for (const name of names) {
    let entry = memory.get(name);
    if (!entry) {
      try {
        const raw = await withRedisTimeout(getRedisClient().get(key(name)));
        if (raw) entry = JSON.parse(raw);
      } catch (_err) {
        /* ignore */
      }
    }
    const intervalMs = intervals[name] ?? entry?.intervalMs ?? null;
    let nextScheduledRunAt = entry?.nextScheduledRunAt || null;
    // If we have lastRun and interval but no next, compute from last success/run
    if (!nextScheduledRunAt && intervalMs && (entry?.lastSuccessAt || entry?.lastRunAt)) {
      const base = new Date(entry.lastSuccessAt || entry.lastRunAt).getTime();
      nextScheduledRunAt = new Date(base + intervalMs).toISOString();
    }
    out.push(
      entry
        ? { ...entry, intervalMs, nextScheduledRunAt }
        : {
            name,
            status: 'idle',
            lastRunAt: null,
            lastSuccessAt: null,
            lastFailureAt: null,
            lastError: null,
            intervalMs,
            nextScheduledRunAt: null,
          }
    );
  }
  return out;
}
