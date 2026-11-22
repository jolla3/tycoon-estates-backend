// src/jobs/scheduler.js
import { bankSyncJob } from './bankSync.job.js';
import { rentStatusJob } from './rentStatus.job.js';
import { smsReminderJob } from './smsReminder.job.js';
import { smsDispatchJob } from './smsDispatch.job.js';
import { dateUtil } from '../utils/date.js';
import { mpesaPullJob } from './mpesaPull.job.js';
import { g5CollectionJob } from './g5Collection.job.js';
import { withLock } from '../utils/distributedLock.js';
import {
  recordJobStart,
  recordJobSuccess,
  recordJobFailure,
  recordJobOutcome,
  classifyJobResult,
  JOB_OUTCOME,
  getJobMetrics,
} from './jobMetrics.js';
import { logger } from '../config/logger.js';

const INTERVALS = {
  bankSync: 5 * 60 * 1000,
  rentStatus: 60 * 60 * 1000,
  smsReminder: 24 * 60 * 60 * 1000,
  smsDispatch: 60 * 1000,
  mpesaPull: 10 * 60 * 1000,
  g5Collection: 60 * 1000,
};

const LOCK_TTL_MS = {
  bankSync: 4 * 60 * 1000,
  rentStatus: 10 * 60 * 1000,
  smsReminder: 10 * 60 * 1000,
  smsDispatch: 2 * 60 * 1000,
  mpesaPull: 8 * 60 * 1000,
  g5Collection: 2 * 60 * 1000,
};

const JOB_NAMES = ['bankSync', 'rentStatus', 'smsReminder', 'smsDispatch', 'mpesaPull', 'g5Collection'];

let timers = [];
let dailyReminderTimer = null;
const startedAt = new Date().toISOString();

function runSafely(name, fn) {
  return () =>
    withLock(`job-lock:${name}`, LOCK_TTL_MS[name], async () => {
      const startedAtMs = Date.now();
      const startedIso = new Date(startedAtMs).toISOString();
      await recordJobStart(name);
      try {
        const result = await fn();
        await recordJobSuccess(name, INTERVALS[name]);
        const classified = classifyJobResult(result);
        await recordJobOutcome(name, {
          ...classified, startedAt: startedIso, finishedAt: new Date().toISOString(),
          durationMs: Date.now() - startedAtMs, error: null,
        });
      } catch (err) {
        await recordJobFailure(name, err.message, INTERVALS[name]);
        await recordJobOutcome(name, {
          outcome: JOB_OUTCOME.FAILED, counts: null, reason: null, startedAt: startedIso,
          finishedAt: new Date().toISOString(), durationMs: Date.now() - startedAtMs,
          error: String(err.message || 'unknown').slice(0, 300),
        });
        throw err;
      }
    }).catch((err) => logger.error({ job: name, error: err.message }, 'Background job failed'));
}

function scheduleDailyRentReminder() {
  const now = dateUtil.now();
  let next = now.hour(9).minute(0).second(0).millisecond(0);
  if (next.isBefore(now)) next = next.add(1, 'day');
  const delay = Math.max(1, next.diff(now));
  dailyReminderTimer = setTimeout(async () => {
    dailyReminderTimer = null;
    await runSafely('smsReminder', smsReminderJob)();
    if (timers.length) scheduleDailyRentReminder();
  }, delay);
}

export function startBackgroundJobs() {
  if (timers.length || dailyReminderTimer) return;
  timers.push(setInterval(runSafely('bankSync', bankSyncJob), INTERVALS.bankSync));
  timers.push(setInterval(runSafely('rentStatus', rentStatusJob), INTERVALS.rentStatus));
  timers.push(setInterval(runSafely('smsDispatch', smsDispatchJob), INTERVALS.smsDispatch));
  timers.push(setInterval(runSafely('mpesaPull', mpesaPullJob), INTERVALS.mpesaPull));
  timers.push(setInterval(runSafely('g5Collection', g5CollectionJob), INTERVALS.g5Collection));
  scheduleDailyRentReminder();
  logger.info('Background jobs started (Redis-locked, safe for multiple instances)');
}

export function stopBackgroundJobs() {
  timers.forEach(clearInterval);
  timers = [];
  if (dailyReminderTimer) clearTimeout(dailyReminderTimer);
  dailyReminderTimer = null;
}

export async function getBackgroundJobStatus() {
  const metrics = await getJobMetrics(JOB_NAMES, INTERVALS);
  return {
    schedulerStartedAt: startedAt,
    // Timers exist only in the process that called startBackgroundJobs(); this reports THIS
    // process. Run evidence below comes from shared (Redis) metrics written by whichever
    // process actually runs the jobs.
    initializedInThisProcess: timers.length > 0 || Boolean(dailyReminderTimer),
    registeredJobs: JOB_NAMES,
    runningJobs: metrics.filter((m) => m.status === 'running').map((m) => m.name),
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
      lastOutcome: m.status === 'running' ? { outcome: JOB_OUTCOME.RUNNING } : (m.lastOutcome || null),
    })),
  };
}
