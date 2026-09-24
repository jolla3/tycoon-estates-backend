// src/jobs/rentStatus.job.js — generates this period's RentCharge for every
// occupied house per estate. Must be idempotent: re-runs must not fail with
// E11000 when charges already exist.
import { Estate } from '../models/Estate.js';
import { rentService } from '../services/rent.service.js';
import { logger } from '../config/logger.js';
import { ensureIndexes } from '../utils/ensureIndexes.js';

let indexesAligned = false;

export async function rentStatusJob() {
  // Once per process: drop legacy unique keys that omit chargeType so
  // upserts under (clientId, houseId, period, chargeType) cannot collide.
  if (!indexesAligned) {
    try {
      await ensureIndexes();
      indexesAligned = true;
    } catch (err) {
      logger.warn({ error: err.message }, 'rentStatusJob: index alignment failed');
    }
  }

  const estates = await Estate.find({ isActive: true });
  let createdTotal = 0;
  const errors = [];

  for (const estate of estates) {
    try {
      const result = await rentService.generateChargesForEstate(estate.clientId, estate._id);
      createdTotal += result?.created || 0;
    } catch (err) {
      // Isolate per-estate failure so one estate cannot poison the whole job
      // and surface a permanent lastError for unrelated estates.
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
      // Duplicate key after alignment is still treated as non-fatal for the job
      if (err?.code === 11000 || err?.codeName === 'DuplicateKey') {
        continue;
      }
      errors.push({ estateId: String(estate._id), error: msg });
    }
  }

  if (errors.length && errors.length === estates.length) {
    // Every estate failed with a non-duplicate error — rethrow so health lastError updates
    throw new Error(errors[0].error);
  }

  return { estates: estates.length, created: createdTotal, failedEstates: errors.length };
}
