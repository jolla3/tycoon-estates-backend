// src/utils/crossTenancyAllocation.js
//
// G5 / G3 — deterministic Tenant-level allocation across Tenancies.
//
// Pure functions only. All amounts are integer cents.
//
// Locked rule: OLDEST ELIGIBLE DUE OBLIGATION FIRST, with a stable total order:
//   1. period            ascending (YYYY-MM)
//   2. dueDate           ascending (null last)
//   3. chargeType        RENT < WATER < ELECTRICITY < OTHER
//   4. tenancy startAt   ascending (older Tenancy first)
//   5. tenancyId         ascending (string compare)
//   6. chargeId          ascending (string compare)
//
// Unlike utils/allocation.js#planAllocation (which puts excess on the last
// charge and yields OVERPAID), this planner NEVER allocates beyond a charge's
// remaining balance. Anything not allocated is returned as `surplusCents`,
// which the caller records as Tenant-level credit.

import { CHARGE_TYPE_PRIORITY } from './allocation.js';

function idStr(v) {
  return v == null ? '' : String(v);
}

function cmp(a, b) {
  if (a < b) return -1;
  if (a > b) return 1;
  return 0;
}

function dueMs(charge) {
  if (!charge.dueDate) return Number.POSITIVE_INFINITY;
  const ms = new Date(charge.dueDate).getTime();
  return Number.isNaN(ms) ? Number.POSITIVE_INFINITY : ms;
}

/**
 * @param {Array} charges  RentCharge-like { _id, tenancyId, period, dueDate, chargeType, balanceCents }
 * @param {Map<string, number|Date>} tenancyStartMs  tenancyId -> startAt (ms or Date)
 */
export function sortObligations(charges, tenancyStartMs = new Map()) {
  const startOf = (c) => {
    const v = tenancyStartMs.get(idStr(c.tenancyId));
    if (v == null) return Number.POSITIVE_INFINITY;
    const ms = v instanceof Date ? v.getTime() : Number(v);
    return Number.isFinite(ms) ? ms : Number.POSITIVE_INFINITY;
  };
  return [...charges].sort((a, b) => (
    cmp(a.period, b.period)
    || cmp(dueMs(a), dueMs(b))
    || cmp(CHARGE_TYPE_PRIORITY[a.chargeType] ?? 99, CHARGE_TYPE_PRIORITY[b.chargeType] ?? 99)
    || cmp(startOf(a), startOf(b))
    || cmp(idStr(a.tenancyId), idStr(b.tenancyId))
    || cmp(idStr(a._id), idStr(b._id))
  ));
}

function assertSafeCents(value, field) {
  if (!Number.isSafeInteger(value) || value < 0) {
    const err = new Error(`${field} must be a non-negative safe integer`);
    err.code = 'INVALID_CENTS';
    throw err;
  }
}

/**
 * Plan allocation of `poolCents` over outstanding obligations.
 *
 * @returns {{ slices: Array<{charge, tenancyId: string, amountCents: number}>,
 *             allocatedCents: number, surplusCents: number,
 *             perTenancy: Map<string, number> }}
 */
export function planTenantAllocation(charges, poolCents, { tenancyStartMs } = {}) {
  assertSafeCents(poolCents, 'poolCents');
  const ordered = sortObligations(
    (charges || []).filter((c) => Number.isSafeInteger(c.balanceCents) && c.balanceCents > 0),
    tenancyStartMs
  );

  let remaining = poolCents;
  const slices = [];
  const perTenancy = new Map();

  for (const charge of ordered) {
    if (remaining <= 0) break;
    const amountCents = Math.min(remaining, charge.balanceCents);
    if (amountCents <= 0) continue;
    const tenancyId = idStr(charge.tenancyId);
    slices.push({ charge, tenancyId, amountCents });
    perTenancy.set(tenancyId, (perTenancy.get(tenancyId) || 0) + amountCents);
    remaining -= amountCents;
  }

  const allocatedCents = poolCents - remaining;
  // Reconciliation invariant: pool = allocated + surplus, no loss, no duplication.
  if (allocatedCents + remaining !== poolCents) {
    throw new Error('allocation invariant violated');
  }
  return { slices, allocatedCents, surplusCents: remaining, perTenancy };
}

/**
 * Two-stage plan used by the M-PESA posting operation:
 *   stage 1: existing Tenant credit pays the oldest obligations first;
 *   stage 2: the new verified receipt pays the oldest REMAINING obligations;
 *   any receipt remainder is new Tenant credit.
 *
 * Returns total reconciliation:  receipt = receiptApplied + newCredit
 * and credit conservation:       creditBefore = creditApplied + creditRemaining
 */
export function planReceiptWithCredit(charges, { receiptCents, creditCents = 0 }, opts = {}) {
  assertSafeCents(receiptCents, 'receiptCents');
  assertSafeCents(creditCents, 'creditCents');

  const creditPlan = planTenantAllocation(charges, creditCents, opts);

  const consumed = new Map();
  for (const s of creditPlan.slices) {
    const key = idStr(s.charge._id);
    consumed.set(key, (consumed.get(key) || 0) + s.amountCents);
  }
  const reduced = (charges || []).map((c) => ({
    ...(typeof c.toObject === 'function' ? c.toObject() : c),
    _id: c._id,
    balanceCents: (c.balanceCents || 0) - (consumed.get(idStr(c._id)) || 0),
  }));

  const receiptPlan = planTenantAllocation(reduced, receiptCents, opts);

  const out = {
    creditSlices: creditPlan.slices,
    creditAppliedCents: creditPlan.allocatedCents,
    creditRemainingCents: creditPlan.surplusCents,
    receiptSlices: receiptPlan.slices,
    receiptAppliedCents: receiptPlan.allocatedCents,
    newCreditCents: receiptPlan.surplusCents,
    receiptPerTenancy: receiptPlan.perTenancy,
    creditPerTenancy: creditPlan.perTenancy,
  };

  if (out.receiptAppliedCents + out.newCreditCents !== receiptCents) {
    throw new Error('receipt reconciliation invariant violated');
  }
  if (out.creditAppliedCents + out.creditRemainingCents !== creditCents) {
    throw new Error('credit conservation invariant violated');
  }
  return out;
}
