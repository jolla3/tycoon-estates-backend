// Pure tenancy-resolution rules for manual payments (no DB access).
// A House selected today does not prove who owed rent in an older period. Resolve
// the exact Tenancy that overlaps the requested Nairobi rent due-day date.
import { isTenancyEligibleForPeriod, tenancyPeriodEligibility } from './tenancyEligibility.js';

export const TENANCY_RESOLUTION = Object.freeze({ UNIQUE: 'UNIQUE', AMBIGUOUS: 'AMBIGUOUS', NONE: 'NONE' });

const REASONS = Object.freeze({
  NO_PERIOD: 'Invalid billing period',
  BAD_STATUS: 'Tenancy is not active or closed',
  BAD_START: 'Tenancy has an invalid start date',
  BAD_END: 'Tenancy has an invalid end date',
  STARTS_AFTER_DUE_DAY: 'Tenancy started after this period’s rent due day; the next cycle is its first eligible billing period',
  ENDS_BEFORE_DUE_DAY: 'Tenancy had ended before this period’s rent due day',
});

/** Human-readable reason a tenancy cannot take a payment for `period` (null when it can). Uses the same boundary as isTenancyEligibleForPeriod. */
export function tenancyIneligibleReason(tenancy, period, dueDay = 5) {
  const { code } = tenancyPeriodEligibility(tenancy, period, dueDay);
  return code ? REASONS[code] : null;
}

/**
 * Classify the tenancies of one house for a period.
 * @param {Array} tenancies candidate tenancies of the SAME house (caller scopes by client/estate/house)
 * @param {string} period YYYY-MM
 * @param {{tenantId?: string}} [opts] when given, only that tenant's tenancies can be selected
 */
export function classifyTenanciesForPeriod(tenancies, period, { tenantId = null, dueDay = 5 } = {}) {
  const eligible = (tenancies || []).filter((t) =>
    isTenancyEligibleForPeriod(t, period, dueDay)
    && (!tenantId || String(t.tenantId) === String(tenantId)));
  if (eligible.length === 1) return { status: TENANCY_RESOLUTION.UNIQUE, tenancy: eligible[0], eligible };
  if (eligible.length === 0) return { status: TENANCY_RESOLUTION.NONE, tenancy: null, eligible };
  return { status: TENANCY_RESOLUTION.AMBIGUOUS, tenancy: null, eligible };
}
