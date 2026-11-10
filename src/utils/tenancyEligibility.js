import { dateUtil } from './date.js';

/**
 * G3 interim full-period eligibility:
 * startAt <= periodStart AND (endAt is null OR endAt >= nextPeriodStart)
 */
export function isTenancyEligibleForPeriod(tenancy, period) {
  if (!tenancy || !period) return false;
  if (!['ACTIVE', 'CLOSED'].includes(tenancy.status)) return false;
  const periodStart = dateUtil.startOfMonth(period).toDate();
  const nextPeriodStart = dateUtil.startOfMonth(period).add(1, 'month').toDate();
  const startAt = new Date(tenancy.startAt);
  if (Number.isNaN(startAt.getTime())) return false;
  if (startAt > periodStart) return false;
  if (tenancy.endAt != null) {
    const endAt = new Date(tenancy.endAt);
    if (Number.isNaN(endAt.getTime())) return false;
    if (endAt < nextPeriodStart) return false;
  }
  return true;
}
