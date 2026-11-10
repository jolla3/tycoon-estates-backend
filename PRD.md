# Tycoon Estates: Tenancy-Aware Accounting Foundation and Daraja Collections PRD

**Status:** G2 design freeze — 2026-11-07  
**Document owner:** Tycoon Estates  
**Repository:** `jolla3/tycoon-estates-backend`  
**Code baseline:** `main` at `569c96c8f6a017c114e9abbe8b5f15b72d6e934a` (Git-verified at G1/G2)  
**Document revision:** 2026-11-07 (G2)  
**Implementation status:** Proposed architecture only. No Category B or M-PESA implementation is authorized by this document. Proposed models do **not** exist in the baseline codebase.

## 1. Product definition

Tycoon Estates is a multi-tenant property and rent-payment monitoring system. A **client** owns or manages one or more **estates**. Staff operate within a client and, where applicable, an estate-level access restriction. The backend stores occupancy (tenancy), rent charges, incoming payment sources, confirmed payments, allocations and financial ledger entries.

This programme has two scopes:

1. **Category B — Tenancy-aware accounting foundation**  
   Correct occupancy identity and shared financial ownership so money is attributed to the correct historical occupancy.
2. **M-PESA PayBill collection (Daraja)**  
   C2B confirmation (primary) and Pull Transactions (recovery) converge on one canonical receipt and the **same** shared financial engine. No separate M-PESA ledger.

M-PESA financial posting is forbidden until the Co-op compatibility gate (G4) passes and owners separately authorize G5.

### 1.1 Governance and delivery gates

| Gate | Meaning | Status |
|------|---------|--------|
| Stage 0 | Repository audit | Done |
| G1 | Canonical checkout + DB-free unit baseline | Done: SHA `569c96c…`; 10 suites / 34 unit tests passed; integration **not run** |
| G2 | Architecture challenge and design freeze | **This document set** |
| G3 | Category B implementation + dry-run migration prep | Not authorized until owners approve G2 |
| G4 | Co-op compatibility against corrected engine | Blocked on G3 |
| G5 | Daraja wire-contract + M-PESA collection integration | Blocked on G4 + owner auth |

G3 requires an **approved disposable MongoDB replica-set** test environment, or an explicit owner-approved alternative with documented risk. `tests/helpers/db.js` clears all collections in its configured database and must never point at valuable data.

G1 unit results are **not** a claim that Co-op is regression-green end-to-end.

## 2. Users and actors

| Actor | Need |
|-------|------|
| Client Owner / Client Admin | Configure estates, review unmatched payments, resolve historical attribution, monitor balances. |
| Authorized estate staff | Operate only within permitted estate scope. |
| Tenant | Stable payment reference for **their occupancy**; no Tycoon login required to pay. |
| Third-party payer | Pay using the tenancy reference without creating an account. |
| Bank (Co-op) | Deliver credits via webhook/poll into `BankTransaction`. |
| Safaricom Daraja | Deliver C2B callbacks and Pull responses (future). |
| Tycoon backend | Persist, deduplicate, match, allocate, post ledger, audit. |

MSISDN is supporting payment metadata, never the tenancy identity key. Payer ≠ tenant is allowed.

## 3. Problem statement

Baseline code (confirmed at `569c96c`) treats occupancy as mutable `Tenant.houseId` / `House.tenantId` and scopes charges, allocations and ledger running balances to the **physical house**. Consequences:

- Moves overwrite occupancy history.
- New occupants can inherit prior arrears in allocation and SMS/reporting views.
- Co-op matching uses client-scoped house number/aliases and current house tenant.
- Webhook/poll reconciles only when a `BankTransaction` document is first created; stored-but-unreconciled rows are skipped on retry.
- Manual payments omit structured origin/tender metadata.
- Deposit is unique per client+tenant (lifetime), not per occupancy.
- `HouseBillingConfig` effective dates are not applied in charge selection.
- Runtime `ensureIndexes` can drop/sync indexes on ordinary startup.

Category B must fix ownership and processing durability **before** M-PESA posting.

## 4. Goals

1. Introduce immutable **Tenancy** as the financial ownership boundary.  
2. Scope new RentCharge, Payment, PaymentAllocation, Ledger and Deposit records to `tenancyId`.  
3. Preserve Co-op adapter contracts while moving matching and posting to the shared engine.  
4. Make ingestion retry-safe without duplicate financial posts.  
5. Keep one Ledger; separate rent vs deposit account categories.  
6. Leave ambiguous legacy data unattributed until human resolution.  
7. Gate M-PESA behind Co-op compatibility proof.

## 5. Non-goals (G2–G3)

- Implementing Daraja or posting M-PESA in G3.  
- Silently backfilling `tenancyId` by guessing from current house occupancy.  
- Automatic write-off of unattributed balances.  
- Mid-period rent proration (v1).  
- Multiple concurrent active tenancies on one house (v1).  
- Forcing every Payment to have a bank or M-PESA provider ID (manual remains valid).  
- Making `BankTransaction` nullable for shortcode receipts.  
- Exposing MongoDB ObjectIds in browser URLs (admin UI constraint).

## 6. Functional requirements

### 6.1 Tenancy lifecycle

- **FR-T1:** Creating an occupancy creates a new Tenancy (`startAt` inclusive).  
- **FR-T2:** Move-out sets `endAt` (exclusive) and status closed; does not delete history.  
- **FR-T3:** Move to another house closes the prior Tenancy and opens a new Tenancy transactionally with compatibility pointer updates.  
- **FR-T4:** A closed Tenancy is never repointed to a different tenant, house, estate or client.  
- **FR-T5:** At most one **active** Tenancy per house (enforced).  
- **FR-T6:** No product requirement for at most one active Tenancy per Tenant unless owners add it later.  
- **FR-T7:** Corrections to mistaken tenancy data are auditable (no silent reopen/repurpose).

### 6.2 Financial ownership

- **FR-F1:** New RentCharge, Payment, Ledger (rent category) and Deposit rows require `tenancyId`.  
- **FR-F2:** PaymentAllocation allowed only when Payment and RentCharge share the same `tenancyId`.  
- **FR-F3:** House/estate balances are aggregates for reporting, not allocation keys.  
- **FR-F4:** Former tenancy arrears do not auto-apply to a new occupancy of the same house.

### 6.3 Payment origins

Mutually exclusive origin categories:

| Origin | Required identity / metadata |
|--------|------------------------------|
| BANK | `bankTransactionId` |
| MPESA | `mpesaReceiptId` (future model) |
| MANUAL | Recording actor, recorded-at, tender method (cash / cheque / bank transfer / M-PESA / other), optional evidence/reference, audit context |

- **FR-P1:** Origin ≠ tender method (a MANUAL row may record tender M-PESA).  
- **FR-P2:** At most one Payment per BankTransaction; at most one per MpesaReceipt.  
- **FR-P3:** Manually recorded M-PESA tender must not double-post when the same provider receipt is later ingested; link requires **exact** provider receipt identity and auditable resolution — not amount/date heuristics alone.  
- **FR-P4:** Existing Payments without source IDs are **not** bulk-labelled MANUAL without data review.

### 6.4 Co-op ingestion and matching

- **FR-C1:** Preserve BankAccount, BankTransaction, Co-op provider transport and actual authentication behaviour (Basic credential check as implemented — not described as cryptographic signature unless code changes).  
- **FR-C2:** Shared engine consumes normalized bank transactions, not raw Co-op HTTP shapes.  
- **FR-C3:** Match order: estate scope → exact house number/alias → Tenancy containing transaction timestamp → unique match or UNMATCHED.  
- **FR-C4:** Post-move-out payments that only cite a house number stay unmatched until an operator selects a **Tenancy**.  
- **FR-C5:** Manual assignment targets Tenancy; `matchedHouseId` / `matchedTenantId` remain compatibility fields alongside `matchedTenancyId`.

### 6.5 Retry and recovery

- **FR-R1:** Durable reconciliation states on the source (e.g. RECEIVED / CLAIMED / POSTED / FAILED_RETRYABLE / FAILED_TERMINAL).  
- **FR-R2:** Replay of webhook or poll may re-attempt unposted sources; must not duplicate Payment/allocations/Ledger.  
- **FR-R3:** Financial posting and source state transition to POSTED commit in one Mongo transaction.  
- **FR-R4:** Redis may coordinate workers; durable claim/state is in MongoDB.

### 6.6 Deposits

- **FR-D1:** One Deposit per Tenancy (not tenant-lifetime unique).  
- **FR-D2:** Move does not auto-transfer deposit.  
- **FR-D3:** Approved transfer is explicit, atomic, audited, with source and destination Tenancy and correct liability movements — never as rent credit.

### 6.7 Billing configuration

- **FR-B1:** `effectiveFrom` / `effectiveTo` govern applicability at **billing-period boundaries**.  
- **FR-B2:** No silent mid-period proration in v1.  
- **FR-B3:** No overlapping active configs for same house + charge type.  
- **FR-B4:** Each RentCharge stores applied amount and config/version reference for reproducibility.

### 6.8 Platform rules

- **FR-X1:** Multi-document financial writes require Mongo transactions; if unsupported, **fail closed**.  
- **FR-X2:** No destructive index drop/sync on ordinary startup; explicit versioned migrations only.  
- **FR-X3:** Client isolation preserved; estate filters enforced on staff-scoped operations.  
- **FR-X4:** Admin UI must not put internal Mongo IDs in public URLs; use state-driven navigation.

## 7. Legacy data policy

| Class | Handling |
|-------|----------|
| Potentially attributable | Eligible for dry-run proposal with evidence fields listed |
| Ambiguous | Manual review queue; not auto-assigned |
| Unattributable from current data | Remain visible as legacy/unattributed; excluded from new-tenancy auto-allocation |
| Already inconsistent | Detected in dry-run; owner-directed repair |

No silent write-offs. No invented occupancy dates. No copying current `House.tenantId` onto historical financial rows.

## 8. Acceptance criteria (Category B / G3–G4)

1. New occupancy paths create/close Tenancy records transactionally.  
2. New charges/payments/ledger/deposits carry `tenancyId`; allocation rejects cross-tenancy pairs.  
3. Co-op webhook + poll retry posts at most one Payment per bank transaction after simulated crash mid-reconcile.  
4. Matching uses estate + time-bounded tenancy; ambiguous cases stay unmatched.  
5. Manual payment supports origin MANUAL with actor, tender method and audit metadata.  
6. House dashboard aggregates do not present prior-occupant arrears as the current occupancy balance.  
7. Billing config change at period boundary affects subsequent periods only; historical charges unchanged.  
8. Dry-run migration report classifies legacy rows without writing.  
9. Integration tests run only against disposable replica-set (or owner-approved alternative).  
10. Unit + integration evidence recorded before G4 sign-off.

## 9. Unresolved owner decisions

1. Whether a Tenant may have multiple **simultaneous** active Tenancies across houses (allowed by default in G2 design; product may restrict later).  
2. Exact MANUAL tender enum and mandatory evidence fields for compliance.  
3. Operator UX and permissions for historical Tenancy assignment and deposit transfer.  
4. Whether any legacy open house-level balances require a formal “unattributed suspense” account category in Ledger.  
5. STK display shortcode vs C2B sandbox shortcode verification (retain explicit simulator gate; do not assume equality).  
6. Timeline and staffing for dry-run review of ambiguous production rows.  
7. Acceptance of residual risk if G3 proceeds with only partial integration coverage.

## 10. Document alignment

This PRD, `architecture.md` and `architecture-summary.md` share the same G2 decisions on tenancy lifecycle, payment origins, deposits, legacy balances, Co-op matching/retry, ledger semantics, billing effective dates, Mongo transactions, index policy and delivery gates. Proposed schema is target design, not current code.
