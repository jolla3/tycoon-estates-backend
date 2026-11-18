// Pure tenancy-resolution rules for manual payments (no DB access).
// A house selected today does not prove who owed rent in an older period, so the
// payment must be bound to ONE validated Tenancy that covers the whole period.
import { isTenancyEligibleForPeriod } from './tenancyEligibility.js';

export const TENANCY_RESOLUTION = Object.freeze({ UNIQUE: 'UNIQUE', AMBIGUOUS: 'AMBIGUOUS', NONE: 'NONE' });

/** Human-readable reason a tenancy cannot take a payment for `period` (null when it can). */
export function tenancyIneligibleReason(tenancy, period) {
  if (!tenancy || !['ACTIVE', 'CLOSED'].includes(tenancy.status)) return 'Tenancy is not active or closed';
  if (isTenancyEligibleForPeriod(tenancy, period)) return null;
  const start = new Date(tenancy.startAt);
  if (Number.isNaN(start.getTime())) return 'Tenancy has an invalid start date';
  // Distinguish by checking whether the start alone already fails the period start.
  const periodStart = new Date(`${period}-01T00:00:00Z`);
  const startedLate = start.getTime() > periodStart.getTime() + 24 * 3600 * 1000;
  return startedLate
    ? 'Tenancy began after the start of this period (partial-period billing is not supported yet)'
    : 'Tenancy ended before the end of this period (partial-period billing is not supported yet)';
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
