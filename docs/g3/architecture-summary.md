# G3 — Short architecture handoff

**Backend:** `0dbf7ef75ed6c1a39e24775aec9a86e08f7d0617`  
**Frontend:** `a27f20dd3244cdc7370cffa16b70c6cd32a45576`  
**Date:** 25 November 2026

## Runtime

Node.js `>=18` (ES modules), Express 4, MongoDB/Mongoose 8, Redis/ioredis for supporting coordination, Zod validation, Jest and Supertest. MongoDB records and transactions remain the financial authority; Redis is not a ledger.

## Product and ownership

G3 is the financial source of truth for Tenancy, RentCharge, Payment, PaymentAllocation, Ledger, Tenant credit and security deposits. Tenant is a person/account; Tenancy is exact occupancy. Rent and deposits are separate. The product is landlord/house-centric, not a tenant portal.

## Invariants

- Every rent allocation and deposit movement targets an exact Tenancy.
- A Tenant may have multiple active Tenancies; never use arbitrary `findOne()` to choose one.
- Tenant credit is scoped to Client + Estate + Tenant and already applies oldest-first across that Tenant's Tenancies in the same Estate.
- Bank/M-PESA records are evidence until G3 posts a Payment and Ledger movement.
- Historical charges remain unchanged; plan updates are prospective.
- Monthly rent uses the effective RENT-line due day in Africa/Nairobi; move-ins after that date start the next full monthly cycle without proration.
- Automatic billing checks the current and next cycle, then existing Tenant/Estate credit applies oldest-first to the next eligible RentCharge.
- Authenticated API requests retain cookie sessions and CSRF.

## Current corrective work

1. Deposit identity is Tenant-ID based and ambiguous; change to exact Tenancy selection with estate validation.
2. Deposit settlement currently does not refund or move out; remove false UI promise and keep combined lifecycle blocked pending owner policy.
3. Reject paid deposit requirement changes with typed `409 Conflict`; do not implement adjustment behavior.
4. Permit `Idempotency-Key` in CORS without weakening CSRF.
5. Make ambiguous manual-payment options searchable/paginated beyond the first 20.
6. Add HouseType editor to workspace and explain prospective impact on existing `HOUSE_TYPE` houses.
7. Use due-day-cycle billing: move-ins on/before the due date join that cycle; later move-ins start next cycle at the full monthly amount. No proration. Auto-apply existing tenant credit oldest-first.
8. Keep receipt evidence separate from posted Payments in aggregate reporting.

## Do not rebuild

Tenant credit auto-apply, rent ledger, payment allocation, reconciliation or M-PESA merchant multi-estate mapping already exist. Verify rather than duplicate them.

## Do not implement in this scope

- Partial-month proration; preserve full-month-only billing until the owner approves the formula.
- Combined deposit deduction/refund/move-out settlement or any UI promise that it refunds money or closes a Tenancy/House.
- Deposit payment-before-requirement and overpayment behavior; do not choose defaults.
- Paid deposit requirement adjustments; return `409 Conflict` after payment instead.
- Production migration execution. Inspect indexes and run read-only preflight only; execution requires clean evidence, a separate plan and explicit owner approval.
- Co-op production activation, Pull registration/reconciliation or production webhook enablement. CK/SK contract repair does not prove resource-specific scope, token lifecycle, production endpoint access or provider readiness.
