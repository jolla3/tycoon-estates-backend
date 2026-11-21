# G3 — Short architecture handoff

**Backend:** `0dbf7ef75ed6c1a39e24775aec9a86e08f7d0617`  
**Frontend:** `a27f20dd3244cdc7370cffa16b70c6cd32a45576`  
**Date:** 21 November 2026

## Product and ownership

G3 is the financial source of truth for Tenancy, RentCharge, Payment, PaymentAllocation, Ledger, Tenant credit and security deposits. Tenant is a person/account; Tenancy is exact occupancy. Rent and deposits are separate. The product is landlord/house-centric, not a tenant portal.

## Invariants

- Every rent allocation and deposit movement targets an exact Tenancy.
- A Tenant may have multiple active Tenancies; never use arbitrary `findOne()` to choose one.
- Tenant credit is scoped to Client + Estate + Tenant and already applies oldest-first across that Tenant's Tenancies in the same Estate.
- Bank/M-PESA records are evidence until G3 posts a Payment and Ledger movement.
- Historical charges remain unchanged; plan updates are prospective.
- Authenticated API requests retain cookie sessions and CSRF.

## Current corrective work

1. Deposit identity is Tenant-ID based and ambiguous; change to exact Tenancy selection with estate validation.
2. Deposit settlement currently does not refund or move out; remove false UI promise and keep combined lifecycle blocked pending owner policy.
3. Reject false-success deposit requirement updates after payment.
4. Permit `Idempotency-Key` in CORS without weakening CSRF.
5. Make ambiguous manual-payment options searchable/paginated beyond the first 20.
6. Add HouseType editor to workspace and explain prospective impact on existing `HOUSE_TYPE` houses.
7. Keep full-month billing until proration policy is approved.
8. Keep receipt evidence separate from posted Payments in aggregate reporting.

## Do not rebuild

Tenant credit auto-apply, rent ledger, payment allocation, reconciliation or M-PESA merchant multi-estate mapping already exist. Verify rather than duplicate them.

## Hold for owner decision

Deposit deduction/refund/move-out atomicity, paid requirement adjustments, payment before requirement, deposit overpayment and proration formula.
