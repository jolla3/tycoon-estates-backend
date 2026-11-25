import { dateUtil } from './date.js';

/**
 * G3 due-day-cycle eligibility. A tenancy interval [startAt, endAt) must overlap
 * the full Africa/Nairobi calendar date of the effective monthly RENT due day.
 * Move-in on the due date counts; endAt is exclusive.
 */
const PERIOD_RE = /^\d{4}-(0[1-9]|1[0-2])$/;

export function tenancyPeriodEligibility(tenancy, period, dueDay = 5) {
  if (!tenancy || !period || !PERIOD_RE.test(String(period))) return { eligible: false, code: 'NO_PERIOD' };
  if (!['ACTIVE', 'CLOSED'].includes(tenancy.status)) return { eligible: false, code: 'BAD_STATUS' };

  const window = dateUtil.dueDayWindowFor(period, dueDay);
  if (!window || Number.isNaN(window.start.getTime()) || Number.isNaN(window.endExclusive.getTime())) {
    return { eligible: false, code: 'NO_PERIOD' };
  }

  const startAt = new Date(tenancy.startAt);
  if (Number.isNaN(startAt.getTime())) return { eligible: false, code: 'BAD_START' };
  if (startAt >= window.endExclusive) return { eligible: false, code: 'STARTS_AFTER_DUE_DAY' };

  if (tenancy.endAt != null) {
    const endAt = new Date(tenancy.endAt);
    if (Number.isNaN(endAt.getTime())) return { eligible: false, code: 'BAD_END' };
    if (endAt <= window.start) return { eligible: false, code: 'ENDS_BEFORE_DUE_DAY' };
  }
  return { eligible: true, code: null };
}

export function isTenancyEligibleForPeriod(tenancy, period, dueDay = 5) {
  return tenancyPeriodEligibility(tenancy, period, dueDay).eligible;
}

/** True when the tenancy begins after this period's complete Nairobi due-date day. */
export function tenancyStartsAfterDueDay(tenancy, period, dueDay = 5) {
  const window = dateUtil.dueDayWindowFor(period, dueDay);
  const startAt = new Date(tenancy?.startAt);
  return Boolean(window && !Number.isNaN(startAt.getTime()) && startAt >= window.endExclusive);
}

/**
 * Exact MongoDB equivalent of tenancyPeriodEligibility. Returns null for an
 * invalid period, so invalid input never broadens a query.
 */
export function eligibleTenancyFilter(period, dueDay = 5) {
  if (!period || !PERIOD_RE.test(String(period))) return null;
  const window = dateUtil.dueDayWindowFor(period, dueDay);
  if (!window || Number.isNaN(window.start.getTime()) || Number.isNaN(window.endExclusive.getTime())) return null;
  return {
    status: { $in: ['ACTIVE', 'CLOSED'] },
    startAt: { $lt: window.endExclusive },
    $or: [{ endAt: null }, { endAt: { $gt: window.start } }],
  };
}
