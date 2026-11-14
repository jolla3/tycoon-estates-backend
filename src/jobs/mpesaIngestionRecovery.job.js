// src/jobs/mpesaIngestionRecovery.job.js
//
// G5.3 — Recovers orphaned/expired/failed-retryable Daraja ingestion events (crash recovery),
// running them through the SAME claim + processClaimedEvent lifecycle as the live request path.
// Never bypasses inbox readiness, canonical identity, or financial posting gates — it calls the
// unmodified production functions. Bounded batch size; safe for multiple concurrent instances
// because the scheduler wraps every tick in the existing Redis distributed lock, and
// claimIngestionEvent's own conditional update is what actually prevents double-processing even
// if the lock were ever bypassed.
import { reclaimExpiredProcessingEvents } from '../services/mpesa/mpesaIngestion.service.js';
import { logger } from '../config/logger.js';

const BATCH_LIMIT = 50;

export async function mpesaIngestionRecoveryJob() {
  const results = await reclaimExpiredProcessingEvents({ limit: BATCH_LIMIT });
  if (results.length) {
    const outcomes = results.reduce((acc, r) => {
      acc[r.outcome] = (acc[r.outcome] || 0) + 1;
      return acc;
    }, {});
    logger.info({ count: results.length, outcomes }, 'mpesaIngestionRecoveryJob processed candidates');
  }
  return { ran: true, count: results.length };
}
