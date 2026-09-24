// src/utils/allocation.js
//
// Deterministic payment allocation across outstanding charges.
// Priority: older periods first; within a period: RENT → WATER → ELECTRICITY → OTHER.
// All amounts are integer cents.

export const CHARGE_TYPE_PRIORITY = {
  RENT: 0,
  WATER: 1,
  ELECTRICITY: 2,
  OTHER: 3,
};

/**
 * Sort charges for allocation: period ASC, then charge-type priority ASC.
 * Mutates a copy; does not mutate the input array.
 */
export function sortChargesForAllocation(charges) {
  return [...charges].sort((a, b) => {
    if (a.period < b.period) return -1;
    if (a.period > b.period) return 1;
    const pa = CHARGE_TYPE_PRIORITY[a.chargeType] ?? 99;
    const pb = CHARGE_TYPE_PRIORITY[b.chargeType] ?? 99;
    return pa - pb;
  });
}

/**
 * Allocate `amountCents` across outstanding charges (balanceCents > 0).
 * Returns [{ charge, amountCents }] for each non-zero slice.
 * Overpayment beyond total outstanding is left on the last charge (status OVERPAID).
 */
export function planAllocation(charges, amountCents) {
  if (!Number.isInteger(amountCents) || amountCents <= 0) return [];

  const ordered = sortChargesForAllocation(
    charges.filter((c) => (c.balanceCents ?? 0) > 0 || true)
  );
  // Prefer charges with positive balance; if none, still allow overpay on newest unpaid structure
  const withBalance = ordered.filter((c) => (c.balanceCents ?? 0) > 0);
  const targets = withBalance.length ? withBalance : ordered.slice(-1);

  let remaining = amountCents;
  const plan = [];

  for (let i = 0; i < targets.length && remaining > 0; i += 1) {
    const charge = targets[i];
    const isLast = i === targets.length - 1;
    const balance = Math.max(0, charge.balanceCents ?? 0);

    let slice;
    if (isLast) {
      // Put remainder (including overpayment) on the last charge
      slice = remaining;
    } else {
      slice = Math.min(remaining, balance);
    }

    if (slice > 0) {
      plan.push({ charge, amountCents: slice });
      remaining -= slice;
    }
  }

  return plan;
}

export function statusAfterPayment(amountDueCents, amountPaidCents) {
  const balance = amountDueCents - amountPaidCents;
  if (balance < 0) return 'OVERPAID';
  if (balance === 0) return 'PAID';
  if (amountPaidCents > 0) return 'PARTIAL';
  return 'UNPAID';
}
