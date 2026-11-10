# Tycoon Estates Architecture Summary: Tenancy-Aware Accounting and Daraja Collections

**Revision:** 2026-11-07 — **G2 design freeze**  
**Repository:** `jolla3/tycoon-estates-backend`  
**Code baseline:** `main` at `569c96c8f6a017c114e9abbe8b5f15b72d6e934a` (Git-verified)  
**G1 evidence:** 10 DB-free unit suites / 34 tests passed; integration tests **not run** (no disposable replica set). Co-op is **not** claimed regression-green.  
**Authorization:** Design documents only. No Category B or M-PESA implementation in G2.

## Product

Multi-client property and rent-payment monitoring. Target: safe rent accounting across occupancy changes, then M-PESA PayBill via Daraja C2B v2 and Pull Transactions. Payer need not be the tenant and needs no Tycoon login.

## Delivery sequence (mandatory)

1. **Stage 0 audit** — done (source + addendum).  
2. **G1 Co-op unit baseline** — done (partial unit only).  
3. **G2 design challenge & freeze** — this revision.  
4. **G3 Category B foundation** — Tenancy lifecycle + tenancy-scoped shared financial engine; dry-run migration first; **no** M-PESA posting. Requires approved disposable MongoDB replica set (or owner-approved alternative with risk assessment).  
5. **G4 Co-op compatibility gate** — webhook, poll, retry, manual assign, reports, isolation, accounting regressions against the corrected engine.  
6. **G5 Daraja / M-PESA** — wire-contract verification, then collection models and shared-engine integration. Financial posting blocked until G4 passes and owners authorize G5.

## Stack and source boundary

- Node.js ESM, Express 4, Mongoose 8, MongoDB **replica set required** for multi-document financial transactions.  
- Redis: coordination/rate limits/locks only — **never** financial source of truth.  
- Co-op remains the bank adapter: keep `BankAccount`, `BankTransaction` (required `bankAccountId`, `estateId`), provider interface and transport.  
- M-PESA is a **separate** collection adapter (`MpesaCollectionAccount`, `TenancyPaymentReference`, `MpesaReceipt`). Do **not** force PayBill into `BankTransaction`.

## Key entities (target)

| Entity | Role |
|--------|------|
| **Tenant** | Person/organization identity (not occupancy). |
| **Tenancy** | Immutable occupancy interval: one client, estate, house, tenant; half-open `[startAt, endAt)`. |
| **RentCharge** | Obligation scoped to **tenancyId** (not merely house). |
| **Payment** | One receipt; origin **BANK** \| **MPESA** \| **MANUAL** (mutually exclusive). |
| **PaymentAllocation** | Payment ↔ RentCharge only when both share the same **tenancyId**. |
| **Ledger** | Single journal; movements tenancy-scoped; rent vs deposit **account categories** distinct. |
| **Deposit** | **Per Tenancy** liability; not tenant-lifetime. |
| **BankTransaction** | Bank-specific source (unchanged shape). |
| **MpesaReceipt** | Future M-PESA source (not in baseline code). |

Compatibility projections `House.tenantId`, `Tenant.houseId`, `Tenant.estateId` may remain during migration of callers; they are **not** authoritative for money.

## Non-negotiable invariants

1. New financial ownership boundary = **Tenancy**.  
2. `Payment.tenancyId === RentCharge.tenancyId` for every allocation.  
3. At most one **active** Tenancy per house (v1).  
4. Historical Tenancy never repointed to another tenant/house/estate/client.  
5. Former-occupant arrears **do not** auto-transfer to a new occupancy.  
6. Ambiguous legacy rows stay **unattributed** — never guess from current `House.tenantId`.  
7. One Payment max per `BankTransaction`; one Payment max per `MpesaReceipt`.  
8. Stored-but-unreconciled sources remain **retryable** (not only `created === true`).  
9. Financial multi-document writes use Mongo transactions; **fail closed** if unavailable.  
10. No destructive index drop/sync as ordinary startup side effect.  
11. Manual payments remain first-class; origin ≠ tender method.  
12. M-PESA posting only after G4 + separate owner authorization.  
13. Admin UI: no internal Mongo IDs in browser URLs; state-driven navigation (`useState`).

## Co-op matching (target)

1. Scope by `BankTransaction.estateId`.  
2. Exact house number or registered alias within that estate.  
3. Tenancy whose occupancy interval contains the **transaction timestamp**.  
4. Exactly one Tenancy → continue; else **UNMATCHED** for review.  
5. Manual assign targets a **Tenancy**, not only a house.

## G1 / G3 constraints

- G1 unit baseline is **not** end-to-end Co-op proof.  
- G3 must not proceed without disposable replica-set test environment (or explicit owner risk acceptance).  
- Proposed models and fields in the full architecture are **targets**, not present in code at `569c96c`.

## Major blockers

- Owner approval of this G2 design freeze.  
- Disposable Mongo replica set for G3/G4.  
- Dry-run migration classification before any irreversible data change.  
- Residual product choices listed in PRD (simultaneous tenancies per tenant, STK vs C2B shortcode verification, etc.).

See **architecture.md** for the full design, self-critique, migration policy and test strategy. See **PRD.md** for product requirements and acceptance criteria.

## Runtime reconciliation — 2026-11-10

- The G2 baseline SHA above is historical; current source must be inspected
  independently. These documents do not claim G3/G4 implementation is complete.
- `PaymentAllocation` is authoritative for allocation sums. The deprecated
  `Payment.allocatedCents` mirror is not a startup or accounting authority.
- Startup validates allocation structure. Financial index readiness is
  separate: missing explicit indexes blocks financial writes, not HTTP startup.
- Ordinary startup does not mutate financial identity indexes.
- The exact historical RentCharge house-unique key may carry MongoDB's generated
  name `clientId_1_houseId_1_period_1_chargeType_1_description_1`; classify it
  by verified key and options, not only by a later custom name.
- Old and development-seed records must be classified by provenance. No
  automatic Tenancy attribution or financial reconstruction from current
  House/Tenant pointers.
