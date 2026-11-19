// Pure tenancy-resolution rules for manual payments (no DB access).
// A house selected today does not prove who owed rent in an older period, so the
// payment must be bound to ONE validated Tenancy that covers the whole period.
import { isTenancyEligibleForPeriod, tenancyPeriodEligibility } from './tenancyEligibility.js';

export const TENANCY_RESOLUTION = Object.freeze({ UNIQUE: 'UNIQUE', AMBIGUOUS: 'AMBIGUOUS', NONE: 'NONE' });

const REASONS = Object.freeze({
  NO_PERIOD: 'Invalid billing period',
  BAD_STATUS: 'Tenancy is not active or closed',
  BAD_START: 'Tenancy has an invalid start date',
  BAD_END: 'Tenancy has an invalid end date',
  STARTS_AFTER_PERIOD_START: 'Tenancy began after the start of this period (partial-period billing is not supported yet)',
  ENDS_BEFORE_PERIOD_END: 'Tenancy ended before the end of this period (partial-period billing is not supported yet)',
});

/** Human-readable reason a tenancy cannot take a payment for `period` (null when it can). Uses the same boundary as isTenancyEligibleForPeriod. */
export function tenancyIneligibleReason(tenancy, period) {
  const { code } = tenancyPeriodEligibility(tenancy, period);
  return code ? REASONS[code] : null;
}

/**
 * Classify the tenancies of one house for a period.
 * @param {Array} tenancies candidate tenancies of the SAME house (caller scopes by client/estate/house)
 * @param {string} period YYYY-MM
 * @param {{tenantId?: string}} [opts] when given, only that tenant's tenancies can be selected
 */
export function classifyTenanciesForPeriod(tenancies, period, { tenantId = null } = {}) {
  const eligible = (tenancies || []).filter((t) =>
    isTenancyEligibleForPeriod(t, period)
    && (!tenantId || String(t.tenantId) === String(tenantId)));
  if (eligible.length === 1) return { status: TENANCY_RESOLUTION.UNIQUE, tenancy: eligible[0], eligible };
  if (eligible.length === 0) return { status: TENANCY_RESOLUTION.NONE, tenancy: null, eligible };
  return { status: TENANCY_RESOLUTION.AMBIGUOUS, tenancy: null, eligible };
}
