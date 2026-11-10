import { HouseTypePlanVersion } from '../models/HouseTypePlanVersion.js';
import { HouseType } from '../models/HouseType.js';
import { Errors } from '../utils/errors.js';
import { assertHouseTypeIndexesAligned } from '../utils/houseTypeIndexReadiness.js';

export function validateBillingPeriod(period) {
  if (typeof period !== 'string' || !/^\d{4}-(0[1-9]|1[0-2])$/.test(period)) {
    const error = new Error('Billing period must use YYYY-MM format.');
    error.code = 'INVALID_BILLING_PERIOD';
    throw error;
  }
  return period;
}

export async function appendHouseTypePlanVersion({
  clientId, estateId, houseTypeId, effectiveFromPeriod, lines,
  createdBy = null, changeReason = '', session,
}) {
  const period = validateBillingPeriod(effectiveFromPeriod);
  await assertHouseTypeIndexesAligned();
  if (!session) throw new Error('HouseType plan versions must be appended inside a MongoDB transaction.');

  // Acquire the shared parent-document write point. Plan edits and charge generation
  // update the same field, so one transaction must retry after the other commits.
  const parentLock = await HouseType.updateOne(
    { _id: houseTypeId, clientId, estateId },
    { $inc: { billingPlanRev: 1 } },
    { session }
  );
  if (parentLock.matchedCount !== 1) throw Errors.NotFound('HouseType not found for plan version append.');

  const latestQuery = HouseTypePlanVersion.findOne({ clientId, estateId, houseTypeId })
    .sort({ effectiveFromPeriod: -1, version: -1 });
  if (session) latestQuery.session(session);
  const latest = await latestQuery.lean();
  if (latest && period <= latest.effectiveFromPeriod) {
    const error = new Error(`New plan versions must start after ${latest.effectiveFromPeriod}.`);
    error.code = 'PLAN_VERSION_NOT_PROSPECTIVE';
    throw error;
  }
  const version = (latest?.version || 0) + 1;
  const normalizedLines = (lines || []).map((line) => ({
    lineId: String(line.lineId || `${line.chargeType}:${String(line.description || '').trim()}`),
    chargeType: line.chargeType,
    description: String(line.description || line.chargeType || '').trim(),
    amountCents: line.amountCents,
    dueDay: line.dueDay ?? null,
  }));
  let record;
  try {
    [record] = await HouseTypePlanVersion.create([{
      clientId, estateId, houseTypeId, version,
      effectiveFromPeriod: period,
      lines: normalizedLines,
      createdBy,
      changeReason,
    }], { session });
  } catch (error) {
    if (Number(error?.code) === 11000) {
      throw Errors.Conflict('A concurrent HouseType plan change claimed this version/effective period. Reload and retry.');
    }
    throw error;
  }
  return record;
}

export async function resolveHouseTypePlanVersion({ clientId, estateId, houseTypeId, period, session }) {
  validateBillingPeriod(period);
  await assertHouseTypeIndexesAligned();
  if (!session) throw new Error('HouseType plan resolution must occur inside the charge transaction.');

  // Acquire the same write point used by plan edits. A concurrent edit or charge
  // generation must conflict and retry rather than commit against a stale plan snapshot.
  const parentLock = await HouseType.updateOne(
    { _id: houseTypeId, clientId, estateId },
    { $inc: { billingPlanRev: 1 } },
    { session }
  );
  if (parentLock.matchedCount !== 1) throw Errors.NotFound('HouseType not found during plan resolution.');

  const query = HouseTypePlanVersion.findOne({
    clientId, estateId, houseTypeId,
    effectiveFromPeriod: { $lte: period },
  }).sort({ effectiveFromPeriod: -1, version: -1 });
  if (session) query.session(session);
  return query.lean();
}
