// src/jobs/rentStatus.job.js — generates this period's RentCharges for eligible Tenancies.
// G3.1: indexesAligned is derived from live listIndexes inspection every run — not a sticky Boolean.
import { Estate } from '../models/Estate.js';
import { rentService } from '../services/rent.service.js';
import { smsService } from '../services/sms.service.js';
import { dateUtil } from '../utils/date.js';
import { logger } from '../config/logger.js';
import { ensureIndexes } from '../utils/ensureIndexes.js';
import {
  refreshBillingIndexReadiness,
  areBillingIndexesAligned,
  getBillingIndexReport,
} from '../utils/billingIndexReadiness.js';

export async function rentStatusJob() {
  // Ensure non-unique schema indexes; never drop indexes here.
  try {
    await ensureIndexes();
  } catch (err) {
    logger.error({ error: err.message }, 'rentStatusJob: ensureIndexes failed');
    throw err;
  }

  // Truthful alignment from live inspection (every job run)
  const aligned = await refreshBillingIndexReadiness();
  const report = getBillingIndexReport();
  if (!aligned) {
    const msg = `RentCharge identity indexes not aligned (${report?.reason}). Billing generation aborted.`;
    logger.error({ report }, msg);
    throw new Error(msg);
  }

  const estates = await Estate.find({ isActive: true });
  let createdTotal = 0;
  let billingNotificationsQueued = 0;
  let billingNotificationsSkipped = 0;
  const billingNotificationErrors = [];
  const errors = [];

  for (const estate of estates) {
    try {
      const result = await rentService.generateChargesForEstate(estate.clientId, estate._id);
      createdTotal += result?.created || 0;
      try {
        const notice = await smsService.queueBillingNotificationsForEstate(
          estate.clientId, estate._id, result?.period || dateUtil.currentPeriod(),
          { skipTenantIds: result?.creditApplyFailedTenantIds || [] }
        );
        billingNotificationsQueued += notice?.queued || 0;
        billingNotificationsSkipped += notice?.skipped || 0;
      } catch (notifyErr) {
        const failure = { estateId: String(estate._id), code: notifyErr.code || 'BILLING_NOTIFICATION_ERROR', reason: String(notifyErr.message || 'unknown').slice(0, 200) };
        billingNotificationErrors.push(failure);
        logger.error(failure, 'rentStatusJob: billing notification queue failed');
      }
    } catch (err) {
      const msg = err?.message || String(err);
      logger.error(
        {
          estateId: String(estate._id),
          clientId: String(estate.clientId),
          error: msg,
          code: err?.code,
        },
        'rentStatusJob: estate generation failed'
      );
      // Do not silently skip duplicate-key errors. They can originate from
      // unrelated unique indexes and must remain visible for investigation.
      errors.push({
        estateId: String(estate._id),
        error: msg,
        code: err?.code || null,
        identityConflict: Boolean(err?.g3RentChargeIdentityConflict),
      });
    }
  }

  if (errors.length && errors.length === estates.length) {
    throw new Error(errors[0].error);
  }

  return {
    estates: estates.length,
    attempted: estates.length,
    successful: estates.length - errors.length,
    failed: errors.length,
    created: createdTotal,
    billingNotificationsQueued,
    billingNotificationsSkipped,
    billingNotificationErrors,
    failedEstates: errors.length,
    errors,
    indexesAligned: areBillingIndexesAligned(),
    indexReportReason: report?.reason,
  };
}
