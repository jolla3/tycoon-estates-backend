// src/jobs/mpesaPull.job.js
//
// G5.3 — Operational Pull reconciliation for eligible merchant profiles.
// Default OFF until query method, pagination and result delivery are confirmed.
// Checkpoint advances only after durable inbox persistence of a recognized empty window.

import crypto from 'crypto';
import { MpesaMerchantProfile } from '../models/MpesaMerchantProfile.js';
import {
  acquirePullLease,
  releasePullLease,
  advancePullCheckpoint,
  queryPullTransactions,
  ingestPullPayload,
} from '../services/mpesa/darajaPull.service.js';
import { createDarajaOAuthClientFromEnv } from '../services/mpesa/darajaOAuth.client.js';
import { env } from '../config/environment.js';
import { logger } from '../config/logger.js';
import { INGESTION_SOURCE } from '../services/mpesa/daraja.constants.js';

const DEFAULT_WINDOW_MS = 24 * 60 * 60 * 1000;

function formatDarajaDate(d) {
  const pad = (n) => String(n).padStart(2, '0');
  return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())} ${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}:${pad(d.getUTCSeconds())}`;
}

export async function mpesaPullJob() {
  if (env.DARAJA_PULL_RECONCILIATION_ENABLED !== '1') {
    logger.debug('mpesaPullJob skipped — DARAJA_PULL_RECONCILIATION_ENABLED is not 1');
    return { ran: false, reason: 'pull_reconciliation_disabled' };
  }

  const oauth = createDarajaOAuthClientFromEnv(env);
  if (!oauth) {
    logger.debug('mpesaPullJob skipped — Daraja OAuth not configured');
    return { ran: false, reason: 'no_oauth' };
  }

  // pullCapability VERIFIED is an explicit ops gate — registration alone does not set it.
  const profiles = await MpesaMerchantProfile.find({
    operationalState: { $in: ['ACTIVE'] },
    pullCapability: 'VERIFIED',
    pullRegistrationState: { $in: ['ACCEPTED', 'ALREADY_REGISTERED'] },
  }).limit(50);

  const ownerId = `pull-job:${crypto.randomBytes(4).toString('hex')}`;
  const summary = { profiles: profiles.length, acquired: 0, busy: 0, errors: 0 };

  for (const profile of profiles) {
    const lease = await acquirePullLease(profile, ownerId);
    if (lease.status !== 'ACQUIRED') {
      summary.busy += 1;
      continue;
    }
    summary.acquired += 1;
    const { fenceToken, checkpoint } = lease;

    try {
      const end = new Date();
      const start = checkpoint?.windowEndAt
        ? new Date(checkpoint.windowEndAt.getTime() - 60_000)
        : new Date(end.getTime() - DEFAULT_WINDOW_MS);

      let offset = checkpoint?.lastOffsetValue || '0';
      let pages = 0;
      let lastRowCount = 0;
      const maxPages = 20;
      let allOk = true;

      while (pages < maxPages) {
        const queryResult = await queryPullTransactions(oauth, {
          shortCode: profile.businessShortCode,
          startDate: formatDarajaDate(start),
          endDate: formatDarajaDate(end),
          offSetValue: offset,
        });

        if (!queryResult.ok) {
          allOk = false;
          logger.warn(
            { shortCode: profile.businessShortCode, httpStatus: queryResult.httpStatus },
            'Pull query non-success'
          );
          break;
        }

        const ingest = await ingestPullPayload(queryResult.body, {
          sourceChannel: INGESTION_SOURCE.PULL_QUERY,
          businessShortCode: profile.businessShortCode,
        });
        if (!ingest.allPersisted) {
          allOk = false;
          break;
        }

        lastRowCount = ingest.rowCount;
        pages += 1;
        if (ingest.rowCount === 0) break;
        // Pagination unit BLOCKED — do not invent next offset.
        break;
      }

      if (allOk) {
        if (lastRowCount > 0) {
          await releasePullLease(profile._id, ownerId, fenceToken, { status: 'UNCERTAIN' });
          logger.info(
            { shortCode: profile.businessShortCode, rows: lastRowCount },
            'Pull page persisted; window not advanced — pagination unresolved'
          );
        } else {
          await advancePullCheckpoint(profile._id, ownerId, fenceToken, {
            windowStartAt: start,
            windowEndAt: end,
            lastOffsetValue: offset,
          });
          await releasePullLease(profile._id, ownerId, fenceToken, { status: 'SUCCEEDED' });
        }
      } else {
        await releasePullLease(profile._id, ownerId, fenceToken, { status: 'FAILED' });
      }
    } catch (err) {
      summary.errors += 1;
      logger.error(
        { shortCode: profile.businessShortCode, error: err.message },
        'Pull reconciliation failed'
      );
      await releasePullLease(profile._id, ownerId, fenceToken, { status: 'FAILED' });
    }
  }

  return summary;
}
