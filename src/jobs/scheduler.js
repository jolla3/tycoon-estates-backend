// src/jobs/scheduler.js
import { bankSyncJob } from './bankSync.job.js';
import { rentStatusJob } from './rentStatus.job.js';
import { smsReminderJob } from './smsReminder.job.js';
import { mpesaPullJob } from './mpesaPull.job.js';
import { g5CollectionJob } from './g5Collection.job.js';
import { withLock } from '../utils/distributedLock.js';
import {
  recordJobStart,
  recordJobSuccess,
  recordJobFailure,
  getJobMetrics,
} from './jobMetrics.js';
import { logger } from '../config/logger.js';

const INTERVALS = {
  bankSync: 5 * 60 * 1000,
  rentStatus: 60 * 60 * 1000,
  smsReminder: 15 * 60 * 1000,
  mpesaPull: 10 * 60 * 1000,
  g5Collection: 60 * 1000,
};

const LOCK_TTL_MS = {
  bankSync: 4 * 60 * 1000,
  rentStatus: 10 * 60 * 1000,
  smsReminder: 10 * 60 * 1000,
  mpesaPull: 8 * 60 * 1000,
  g5Collection: 2 * 60 * 1000,
};

const JOB_NAMES = ['bankSync', 'rentStatus', 'smsReminder', 'mpesaPull', 'g5Collection'];

let timers = [];
const startedAt = new Date().toISOString();

function runSafely(name, fn) {
  return () =>
    withLock(`job-lock:${name}`, LOCK_TTL_MS[name], async () => {
      await recordJobStart(name);
      try {
        await fn();
        await recordJobSuccess(name, INTERVALS[name]);
      } catch (err) {
        await recordJobFailure(name, err.message, INTERVALS[name]);
        throw err;
      }
    }).catch((err) => logger.error({ job: name, error: err.message }, 'Background job failed'));
}

export function startBackgroundJobs() {
  timers.push(setInterval(runSafely('bankSync', bankSyncJob), INTERVALS.bankSync));
  timers.push(setInterval(runSafely('rentStatus', rentStatusJob), INTERVALS.rentStatus));
  timers.push(setInterval(runSafely('smsReminder', smsReminderJob), INTERVALS.smsReminder));
  timers.push(setInterval(runSafely('mpesaPull', mpesaPullJob), INTERVALS.mpesaPull));
  timers.push(setInterval(runSafely('g5Collection', g5CollectionJob), INTERVALS.g5Collection));
  logger.info('Background jobs started (Redis-locked, safe for multiple instances)');
}

export function stopBackgroundJobs() {
  timers.forEach(clearInterval);
  timers = [];
}

export async function getBackgroundJobStatus() {
  const metrics = await getJobMetrics(JOB_NAMES, INTERVALS);
  return {
    schedulerStartedAt: startedAt,
    multiInstanceSafe: true,
    intervalsMs: INTERVALS,
    jobs: metrics.map((m) => ({
      name: m.name,
      status: m.status || 'idle',
      lastRunAt: m.lastRunAt || null,
      lastSuccessAt: m.lastSuccessAt || null,
      lastFailureAt: m.lastFailureAt || null,
      lastError: m.lastError || null,
      intervalMs: m.intervalMs || INTERVALS[m.name] || null,
      nextScheduledRunAt: m.nextScheduledRunAt || null,
    })),
  };
}
