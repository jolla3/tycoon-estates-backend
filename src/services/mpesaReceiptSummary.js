// src/services/mpesaReceiptSummary.js
//
// M-PESA aggregate reporting — metric definitions (the contract, before any UI).
//
// Source of truth: MpesaTransaction (merchant-side receipts). Money is read from
// acceptedAmountCents (the amount the platform accepted), never from raw
// provider payloads, and no payload field is ever returned.
//
// Every receipt in the window falls into EXACTLY ONE `state` bucket, chosen by
// precedence, so the buckets always add up to `providerObserved` (no double
// counting):
//
//   1. POSTED        postingState === 'POSTED' — a Payment has been created
//                    through the existing G3 posting/allocation path. The
//                    receipt IS that Payment's money; Payment totals are NOT
//                    added on top of it.
//   2. QUARANTINED   not posted AND verificationState is CONFLICT or
//                    MANUAL_REVIEW (held for review; never counted as rent).
//   3. UNALLOCATED   not posted, not quarantined, and tied to no Estate
//                    (allocationState UNALLOCATED and no attributedEstateId).
//   4. ATTRIBUTED    everything else: tied to an Estate by exact reference
//                    allocation or verified attribution, awaiting posting
//                    (including failed posting attempts).
//
// `verification` is an independent breakdown of the same total by
// verificationState (MATCHED / UNVERIFIED / CONFLICT / MANUAL_REVIEW). It is a
// second lens on the same receipts, not additional money; its counts also sum
// to `providerObserved`.
//
// Estate attribution: allocatedEstateId, else attributedEstateId, else the
// receipt is `unattributed` (visible only to client-wide scope).

const CENTS = (v) => (Number.isSafeInteger(v) && v >= 0 ? v : 0);

export const RECEIPT_STATES = Object.freeze(['POSTED', 'QUARANTINED', 'UNALLOCATED', 'ATTRIBUTED']);
export const VERIFICATION_STATES = Object.freeze(['MATCHED', 'UNVERIFIED', 'CONFLICT', 'MANUAL_REVIEW']);

export function classifyReceipt(r) {
  if (r.postingState === 'POSTED') return 'POSTED';
  if (r.verificationState === 'CONFLICT' || r.verificationState === 'MANUAL_REVIEW') return 'QUARANTINED';
  const estate = r.allocatedEstateId || r.attributedEstateId;
  if (!estate && (r.allocationState ?? 'UNALLOCATED') === 'UNALLOCATED') return 'UNALLOCATED';
  return 'ATTRIBUTED';
}

const bucket = () => ({ count: 0, amountCents: 0 });
const add = (b, cents) => { b.count += 1; b.amountCents += cents; };

/** Pure reducer over receipt documents (lean, projected). */
export function summarizeReceipts(receipts) {
  const providerObserved = bucket();
  const states = Object.fromEntries(RECEIPT_STATES.map((s) => [s, bucket()]));
  const verification = Object.fromEntries(VERIFICATION_STATES.map((s) => [s, bucket()]));
  const posted = { receiptCount: 0, paymentCount: 0, amountCents: 0, creditEarnedCents: 0 };
  const estates = new Map();

  for (const r of receipts) {
    const cents = CENTS(r.acceptedAmountCents);
    const state = classifyReceipt(r);
    add(providerObserved, cents);
    add(states[state], cents);
    add(verification[VERIFICATION_STATES.includes(r.verificationState) ? r.verificationState : 'UNVERIFIED'], cents);

    if (state === 'POSTED') {
      posted.receiptCount += 1;
      posted.amountCents += cents;
      posted.creditEarnedCents += CENTS(r.creditEarnedCents);
      posted.paymentCount += Array.isArray(r.paymentIds) && r.paymentIds.length ? r.paymentIds.length : (r.paymentId ? 1 : 0);
    }

    const estateId = String(r.allocatedEstateId || r.attributedEstateId || '') || null;
    const key = estateId ?? 'unattributed';
    if (!estates.has(key)) {
      estates.set(key, { estateId, providerObserved: bucket(), states: Object.fromEntries(RECEIPT_STATES.map((s) => [s, bucket()])) });
    }
    const e = estates.get(key);
    add(e.providerObserved, cents);
    add(e.states[state], cents);
  }

  return {
    providerObserved,
    states,
    verification,
    posted,
    byEstate: [...estates.values()].sort((a, b) => b.providerObserved.amountCents - a.providerObserved.amountCents),
  };
}

export const SUMMARY_MAX_WINDOW_DAYS = 93;
