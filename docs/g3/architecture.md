# G3 — Tenancy and financial architecture

**Backend baseline:** `main` `0dbf7ef75ed6c1a39e24775aec9a86e08f7d0617` (21 November 2026)  
**Frontend baseline:** `main` `a27f20dd3244cdc7370cffa16b70c6cd32a45576`  
**Scope:** G3 financial ownership. G5 receipt evidence remains governed by `docs/g5/*`; G4 bank-provider integration remains governed by `docs/provider-contracts/*` and the backend G4 documents.

## 1. Runtime stack, boundary and authority

- **Runtime:** Node.js `>=18`, ES modules and Express 4 API.
- **Persistence:** MongoDB through Mongoose 8. Multi-document financial operations depend on MongoDB transaction support and migration-controlled indexes.
- **Supporting infrastructure:** Redis through ioredis is available for coordination/worker concerns; it is not the source of truth for rent, payments, deposits or Ledger balances.
- **Validation and verification:** Zod request validation; Jest and Supertest are the repository test stack.

G3 owns Tenancy identity, RentCharge obligations, Payments, PaymentAllocations, Ledger movements, Tenant credit and deposits. Bank/M-PESA records are upstream observations; they do not bypass G3 posting. A Tenant is an account identity, not an occupancy identity. Every financial operation must resolve to the precise Tenancy and Estate it affects.

```text
Property / Estate / HouseType / House
                 |
              Tenancy
              /     \
        RentCharge  Deposit
             |         |
   Payment / Allocation  DepositMovement
             |         |
           Ledger     Ledger
```

## 2. Records and service ownership

| Record | Responsibility | Required scope |
|---|---|---|
| `Tenancy` | Occupancy interval and lifecycle | Client, Estate, House and Tenant; exact `_id` is the occupancy identity |
| `RentCharge` | Rent/charge obligation | Exact `tenancyId`, period, charge line and immutable amount/plan snapshot |
| `Payment` | Confirmed rent payment/settlement | Origin distinguishes MANUAL, BANK, MPESA and CREDIT; allocation targets exact Tenancy |
| `PaymentAllocation` | Payment-to-charge allocation | Exact Payment, RentCharge and Tenancy IDs |
| `Ledger` | Financial movements/projections | Account category, entry type, source reference and relevant Tenancy |
| `TenantCreditMovement` | Tenant credit receipt/application/surplus | `{clientId, estateId, tenantId}` plus exact applied Tenancy/charge references |
| `Deposit` | Security-deposit obligation and projection | `{clientId, estateId, tenancyId}` |
| `DepositMovement` | Deposit receipt, deduction, refund or transfer | Exact Deposit/Tenancy, movement type, idempotency key and amount |
| `HouseTypePlanVersion` | Prospective rent plan history | HouseType and `effectiveFromPeriod`; never rewrites past charges |

## 3. Existing service boundaries

- `tenancy.service.js`: Tenancy lifecycle and manual-payment candidate resolution.
- `rent.service.js`: rent generation, full-period eligibility, HouseType effective-plan resolution and credit application invocation.
- `tenantCredit.service.js`: serializes Tenant/Estate credit and applies it oldest-first across that Tenant's eligible Tenancies in the same Estate.
- `deposit.service.js`: deposit requirement, movements, refund, transfer and settlement.
- `houseType.service.js` / `houseTypePlanVersion.service.js`: versioned plan mutation and effective-period lookup.
- `accountingPosting.service.js` / `ledger.service.js`: posting and ledger authority.

## 4. Transaction, identity and idempotency rules

1. Multi-document financial writes require MongoDB transaction support and required indexes; readiness checks fail closed.
2. Deposit movement and matching Ledger entry commit atomically. Money-moving deposit operations require a stable idempotency key.
3. Tenant credit serializes at Tenant/Estate account scope and may allocate across eligible Tenancies only within that Estate. This behavior already exists; do not introduce another credit store or application pass.
4. A provider receipt and the Payment created from it are one underlying collection event at different lifecycle layers. Reports must not double count them.
5. Historical charges and ledger entries are immutable. Corrections use auditable adjustment/compensating entries.

## 5. Verified defects and implementation direction

### Deposits: exact Tenancy

Current tenant-level resolution calls `Tenancy.findOne({clientId, tenantId, status:'ACTIVE'})`. The uniqueness boundary is active Tenancy per House, so the query may select arbitrarily when one Tenant has multiple active Tenancies. The lookup also omits the Estate predicate. Routes and frontend wrappers use Tenant ID although Deposit is Tenancy-scoped.

Use an exact Tenancy ID for deposit operations and validate client/Estate ownership. Keep a legacy Tenant-ID route only for a unique match; return a typed conflict on ambiguity. Do not use `Tenant.houseId` as the source of truth.

### Deposits: settlement is not refund or move-out

Current `settle()` stamps `settledAt` and recomputes status. `settleMoveOut()` delegates to it. Neither writes a refund DepositMovement/Ledger entry nor closes Tenancy/House state. Frontend confirmation text therefore overstates the operation.

A complete move-out settlement would need an owner-approved transaction covering allowed deductions, refund of held funds, deposit projection, Ledger movement, exact Tenancy closure and House vacancy. Keep this blocked until policy is approved. A status update must not imply cash was returned.

`ensureRequired()` must not return success when a paid Deposit requirement was not changed. Return conflict or use an explicitly defined adjustment operation. Payment-before-requirement and overpayment behavior remains an owner decision.

### Manual payment candidates

The resolver correctly determines NONE/UNIQUE/AMBIGUOUS over the eligible set, but the options payload is capped at 20 and the frontend does not browse beyond that cap in AMBIGUOUS state. Add a searchable/paginated candidate query using the same eligibility predicate. The resolver's two-row decision bound must not become a population limit.

### HouseType plans

A HouseType update appends a prospective plan version; charge generation reads the version effective for the billing period when `billingSource === 'HOUSE_TYPE'`. Existing houses on that source can consume the future version. Add the missing workspace editor and show effective period, change reason and affected eligible Houses. Preserve historical charges.

### CORS, sessions and CSRF

The frontend authenticated client sends `credentials: 'include'`, `X-CSRF-Token` and `Idempotency-Key` when supplied. Backend CORS currently permits only `Content-Type` and `X-CSRF-Token`. Add `Idempotency-Key` to the CORS allow-list. Preserve origin allow-listing, credentialed cookies and CSRF validation; do not add a bypass.

## 6. API shape constraints

- Deposit endpoints must accept exact `tenancyId` and validate `{clientId, estateId, tenancyId}`. Legacy Tenant-ID routes must return an ambiguity conflict rather than guessing.
- Manual-payment candidate browsing must be server-side, searchable and paginated; return exact candidate tenancy IDs and eligibility metadata. The selected ID is the one passed to payment creation.
- Versioned HouseType updates must carry effective period and reason through validation to the version service.
- CORS preflight must permit the exact client headers and methods for configured origins; mutation authorization remains cookie + CSRF.

## 7. Reporting boundary

Keep provider receipts separate from G3 Payments. If aggregate M-PESA reporting is added, report observed, verified/attributed, unallocated/quarantined and posted states separately. Count a posted Payment once, not again as its source receipt. Estate scoping requires verified attribution, not merely a shared merchant-profile mapping. Banking/SMS report sections follow the applicable product entitlement.

## 8. Operational safety and verification

- Inspect critical indexes read-only and run migration preflight before any migration execution; never execute a production migration from this feature branch.
- Unit tests cover tenancy selection, estate isolation, option search predicates, HouseType effective periods and idempotency conflicts.
- Replica-set integration tests cover deposit movement/Ledger atomicity, refunds, transaction rollback, concurrent retries and same-Estate credit application.
- HTTP tests cover exact CORS preflight headers, credentials, valid CSRF, invalid Origin and invalid CSRF.
- Frontend tests cover multi-Tenancy deposit selection, more than 20 eligible manual-payment candidates, HouseType workspace edit, and report entitlement visibility.
- Live DB index state, browser behavior and provider sandbox readiness are separate evidence gates.
