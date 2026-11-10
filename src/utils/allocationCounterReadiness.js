/**
 * Production readiness: Payment.allocatedCents and PaymentAllocation structural integrity.
 * Read-only — never modifies financial records.
 */
import { Payment } from '../models/Payment.js';
import { PaymentAllocation } from '../models/PaymentAllocation.js';
import { RentCharge } from '../models/RentCharge.js';

let countersVerified = false;
let lastReport = null;

const BATCH = 500;

export function areAllocationCountersReady() {
  return countersVerified;
}

export function getAllocationCounterReport() {
  return lastReport;
}

/** Test helper only — production readiness must come from verifyAllocationCounters. */
export function _setAllocationCountersReadyForTests(value) {
  countersVerified = Boolean(value);
  if (value) {
    lastReport = { ok: true, checkedPayments: 0, checkedAllocations: 0, issues: [], verifiedAt: new Date().toISOString() };
  } else {
    lastReport = null;
    countersVerified = false;
  }
}

function isPositiveSafeInt(v) {
  return Number.isInteger(v) && Number.isSafeInteger(v) && v > 0;
}

function sameId(a, b) {
  return a != null && b != null && String(a) === String(b);
}

function issue(list, type, payload) {
  list.push({ type, ...payload });
}

/**
 * Full structural + counter verification.
 * Readiness is set true only when setReady=true and issues is empty.
 */
export async function verifyAllocationCounters({ setReady = true, session = null } = {}) {
  const issues = [];
  let checkedPayments = 0;
  let checkedAllocations = 0;

  // --- Payments + their allocations ---
  let lastId = null;
  for (;;) {
    const q = Payment.find(lastId ? { _id: { $gt: lastId } } : {})
      .sort({ _id: 1 })
      .limit(BATCH)
      .select('_id clientId estateId houseId tenancyId tenantId amountCents allocatedCents status');
    if (session) q.session(session);
    const batch = await q.lean();
    if (!batch.length) break;

    for (const p of batch) {
      checkedPayments += 1;
      lastId = p._id;

      if (!isPositiveSafeInt(p.amountCents) && p.amountCents !== 0) {
        // amountCents must be positive for CONFIRMED receipts; zero is odd but counter-only issue if no allocs
        if (p.amountCents == null || !Number.isInteger(p.amountCents) || p.amountCents < 0) {
          issue(issues, 'invalid_payment_amount', { paymentId: String(p._id), amountCents: p.amountCents });
        }
      }

      const aq = PaymentAllocation.find({ paymentId: p._id });
      if (session) aq.session(session);
      const allocations = await aq.lean();
      let total = 0;

      for (const a of allocations) {
        checkedAllocations += 1;
        if (!isPositiveSafeInt(a.amountCents)) {
          issue(issues, 'invalid_allocation_amount', {
            paymentId: String(p._id), allocationId: String(a._id), amountCents: a.amountCents,
          });
          continue;
        }
        total += a.amountCents;

        if (!sameId(a.clientId, p.clientId) || !sameId(a.estateId, p.estateId)) {
          issue(issues, 'allocation_client_estate_mismatch', {
            paymentId: String(p._id), allocationId: String(a._id),
          });
        }
        if (p.houseId && a.houseId && !sameId(a.houseId, p.houseId)) {
          issue(issues, 'allocation_house_mismatch', {
            paymentId: String(p._id), allocationId: String(a._id),
          });
        }
        if (p.tenancyId) {
          if (!a.tenancyId || !sameId(a.tenancyId, p.tenancyId)) {
            issue(issues, 'allocation_tenancy_mismatch', {
              paymentId: String(p._id), allocationId: String(a._id),
            });
          }
        } else if (a.tenancyId) {
          issue(issues, 'allocation_tenancy_without_payment_tenancy', {
            paymentId: String(p._id), allocationId: String(a._id),
          });
        }

        const cq = RentCharge.findById(a.rentChargeId);
        if (session) cq.session(session);
        const charge = await cq.lean();
        if (!charge) {
          issue(issues, 'allocation_missing_rent_charge', {
            paymentId: String(p._id), allocationId: String(a._id), rentChargeId: String(a.rentChargeId),
          });
          continue;
        }
        if (!sameId(charge.clientId, p.clientId)
          || !sameId(charge.estateId, p.estateId)
          || !sameId(charge.houseId, p.houseId)) {
          issue(issues, 'charge_ownership_mismatch', {
            paymentId: String(p._id), allocationId: String(a._id), rentChargeId: String(charge._id),
          });
        }
        if (p.tenancyId) {
          if (!charge.tenancyId || !sameId(charge.tenancyId, p.tenancyId)) {
            issue(issues, 'charge_tenancy_mismatch', {
              paymentId: String(p._id), allocationId: String(a._id), rentChargeId: String(charge._id),
            });
          }
        }
      }

      if (total > (p.amountCents || 0)) {
        issue(issues, 'allocation_sum_exceeds_payment', {
          paymentId: String(p._id), allocatedSum: total, amountCents: p.amountCents,
        });
      }
      if ((p.allocatedCents || 0) !== total) {
        issue(issues, 'counter_mismatch', {
          paymentId: String(p._id),
          storedAllocatedCents: p.allocatedCents || 0,
          actualAllocationSum: total,
          amountCents: p.amountCents,
        });
      }
    }
    if (batch.length < BATCH) break;
  }

  // --- Orphan allocations (payment missing) ---
  lastId = null;
  for (;;) {
    const q = PaymentAllocation.find(lastId ? { _id: { $gt: lastId } } : {})
      .sort({ _id: 1 })
      .limit(BATCH)
      .select('_id paymentId clientId estateId rentChargeId amountCents');
    if (session) q.session(session);
    const batch = await q.lean();
    if (!batch.length) break;
    for (const a of batch) {
      lastId = a._id;
      const pq = Payment.findById(a.paymentId).select('_id');
      if (session) pq.session(session);
      const pay = await pq.lean();
      if (!pay) {
        checkedAllocations += 1;
        issue(issues, 'orphan_allocation_missing_payment', {
          allocationId: String(a._id), paymentId: String(a.paymentId),
        });
      }
    }
    if (batch.length < BATCH) break;
  }

  const report = {
    ok: issues.length === 0,
    checkedPayments,
    checkedAllocations,
    issues,
    // backward-compatible alias
    mismatches: issues.filter((i) => i.type === 'counter_mismatch'),
    verifiedAt: new Date().toISOString(),
  };
  lastReport = report;
  if (setReady) {
    countersVerified = report.ok;
  }
  return report;
}
