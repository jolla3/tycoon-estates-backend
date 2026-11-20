import { dateUtil } from './date.js';

/**
 * G3 interim full-period eligibility:
 * startAt <= periodStart AND (endAt is null OR endAt >= nextPeriodStart)
 *
 * Single source of truth for the period boundary. Both the boolean check and the
 * human-readable reason derive from this function so they can never disagree.
 * @returns {{eligible: boolean, code: null|'NO_PERIOD'|'BAD_STATUS'|'BAD_START'|'BAD_END'|'STARTS_AFTER_PERIOD_START'|'ENDS_BEFORE_PERIOD_END'}}
 */
const PERIOD_RE = /^\d{4}-(0[1-9]|1[0-2])$/;

export function tenancyPeriodEligibility(tenancy, period) {
  if (!tenancy || !period || !PERIOD_RE.test(String(period))) return { eligible: false, code: 'NO_PERIOD' };
  if (!['ACTIVE', 'CLOSED'].includes(tenancy.status)) return { eligible: false, code: 'BAD_STATUS' };
  const periodStart = dateUtil.startOfMonth(period).toDate();
  const nextPeriodStart = dateUtil.startOfMonth(period).add(1, 'month').toDate();
  if (Number.isNaN(periodStart.getTime())) return { eligible: false, code: 'NO_PERIOD' };
  const startAt = new Date(tenancy.startAt);
  if (Number.isNaN(startAt.getTime())) return { eligible: false, code: 'BAD_START' };
  if (startAt > periodStart) return { eligible: false, code: 'STARTS_AFTER_PERIOD_START' };
  if (tenancy.endAt != null) {
    const endAt = new Date(tenancy.endAt);
    if (Number.isNaN(endAt.getTime())) return { eligible: false, code: 'BAD_END' };
    if (endAt < nextPeriodStart) return { eligible: false, code: 'ENDS_BEFORE_PERIOD_END' };
  }
  return { eligible: true, code: null };
}

export function isTenancyEligibleForPeriod(tenancy, period) {
  return tenancyPeriodEligibility(tenancy, period).eligible;
}

/**
 * Exact MongoDB filter equivalent of tenancyPeriodEligibility (same boundaries, same status set),
 * so eligibility is decided by the database across the COMPLETE candidate set instead of an
 * in-memory scan of a truncated page. Returns null for an invalid period (nothing is eligible).
 */
export function eligibleTenancyFilter(period) {
  if (!period || !PERIOD_RE.test(String(period))) return null;
  const periodStart = dateUtil.startOfMonth(period).toDate();
  if (Number.isNaN(periodStart.getTime())) return null;
  const nextPeriodStart = dateUtil.startOfMonth(period).add(1, 'month').toDate();
  return {
    status: { $in: ['ACTIVE', 'CLOSED'] },
    startAt: { $lte: periodStart },
    $or: [{ endAt: null }, { endAt: { $gte: nextPeriodStart } }],
  };
}
