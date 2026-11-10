# Tycoon Estates: Tenancy-Aware Accounting and Daraja Architecture

**Status:** G2 design freeze — 2026-11-07  
**Repository:** `jolla3/tycoon-estates-backend`  
**Code baseline:** `main` at `569c96c8f6a017c114e9abbe8b5f15b72d6e934a` (Git-verified)  
**G1 test evidence:** 10 DB-free unit suites, 34 tests passed; `distributedLock.concurrency` excluded (live Redis); Mongo integration **not run**.  
**Implementation status:** This document describes **confirmed current behaviour** and **proposed target architecture**. Proposed models/fields are **not** in the baseline codebase unless marked existing.

---

## 1. Domain boundaries and entities

### 1.1 Bounded contexts

| Context | Responsibility |
|---------|----------------|
| Identity & access | Client, User, session, estateFilter, roles |
| Property | Estate, House, HouseType, HouseBillingConfig |
| Occupancy | Tenant (person), **Tenancy** (occupancy interval) — *Tenancy is proposed* |
| Billing | RentCharge generation from billing config |
| Collections (bank) | BankAccount, BankTransaction, Co-op provider |
| Collections (mobile) | MpesaCollectionAccount, TenancyPaymentReference, MpesaReceipt — *proposed, G5* |
| Financial engine | Payment, PaymentAllocation, Ledger, Deposit, reconciliation |
| Notifications | SMS |
| Audit | AuditLog |

### 1.2 Entity roles (target)

- **Tenant:** durable person/org identity.  
- **Tenancy:** one occupancy of one house by one tenant under one estate/client; half-open `[startAt, endAt)`.  
- **RentCharge:** billed obligation for a tenancy and period/type.  
- **Payment:** single confirmed receipt with mutually exclusive origin.  
- **PaymentAllocation:** links payment to charges of the **same** tenancy.  
- **Ledger:** sole journal of financial movements (rent and deposit categories).  
- **Deposit:** tenancy-scoped liability.  
- **BankTransaction:** existing bank source document.  
- **MpesaReceipt:** future mobile-money source document.

### 1.3 Confirmed current behaviour (baseline code)

At `569c96c`, occupancy is modelled only via mutable `Tenant.houseId` / `Tenant.estateId` and `House.tenantId`. RentCharge uniqueness and outstanding queries are house-scoped. Ledger `runningBalanceCents` is advanced per house. Payment has optional sparse unique `bankTransactionId` and no origin enum. Deposit unique index is `{ clientId, tenantId }`. Co-op webhook verifies a shared Basic secret (header `basic` or body `Basic`), not a cryptographic signature. Reconciliation runs only when `created === true` after idempotent insert. Matching is `clientId` + house number/alias. `assignToHouse` leaves `rentCharge` undefined in the post-commit SMS path. `billingLinesForHouse` ignores effective dates. `ensureIndexes` may drop/sync on connect.

---

## 2. Tenancy lifecycle and state machine

### 2.1 Proposed `Tenancy` model

| Field | Rule |
|-------|------|
| clientId, estateId, houseId, tenantId | Required; immutable after create |
| startAt | Required; inclusive |
| endAt | Null while active; exclusive when set |
| status | `ACTIVE` \| `CLOSED` \| `VOID` (VOID only via audited correction) |
| closeReason | Optional enum (MOVE_OUT, TRANSFER, CORRECTION, …) |
| createdBy / closedBy | Actor references where applicable |

**Uniqueness (proposed):**

- Partial unique: one ACTIVE tenancy per `houseId`.  
- Query index: `{ houseId, startAt, endAt }`, `{ tenantId, startAt }`, `{ clientId, estateId, status }`.

**Interval rule:** payment/charge attribution uses `startAt <= eventTime < endAt` (endAt null ⇒ open-ended).

### 2.2 Transitions

```text
[create occupancy] → ACTIVE
ACTIVE —move-out→ CLOSED (endAt set)
ACTIVE —move-to-house→ CLOSED (old) + ACTIVE (new)  [single Mongo transaction]
CLOSED —correction→ VOID only with audit; never reuse row for new occupant
```

Compatibility projections updated in the **same** transaction as tenancy transitions:

- `House.tenantId`, `House.status`  
- `Tenant.houseId`, `Tenant.estateId`, `Tenant.status` / move dates  

These projections are **not** financial authority. Retirement path: migrate all callers listed in §13 to Tenancy queries; then deprecate projection writes; finally remove fields in a later gated release.

### 2.3 Concurrency

- Active-house uniqueness enforced by partial unique index + transaction.  
- Concurrent move-in to same vacant house: one transaction wins; loser receives conflict error.  
- Payment posting concurrent with move-out: tenancyId fixed at match time inside posting transaction.

---

## 3. Proposed models, indexes and uniqueness

Legend: **E** = exists at baseline · **P** = proposed change/addition

| Model | Key changes |
|-------|-------------|
| Tenancy **P** | New collection |
| RentCharge **E** | Add required `tenancyId` for **new** rows; unique key becomes tenancy-scoped; retain houseId as denormalized filter |
| Payment **E** | Add `tenancyId`; add `origin` enum BANK\|MPESA\|MANUAL; add MANUAL metadata fields; keep `bankTransactionId`; add future `mpesaReceiptId` |
| PaymentAllocation **E** | Enforce same tenancyId as payment and charge (app + optional denormalized tenancyId) |
| Ledger **E** | Add `tenancyId`; add `accountCategory` RENT\|DEPOSIT; rethink running balance (§9) |
| Deposit **E** | Unique on tenancyId; remove tenant-lifetime uniqueness as authority |
| BankTransaction **E** | Add reconciliation processing state fields **P**; add optional `matchedTenancyId` **P**; keep matchedHouseId/matchedTenantId |
| HouseBillingConfig **E** | Enforce non-overlapping effective ranges per house+chargeType **P** behaviour |
| MpesaCollectionAccount / TenancyPaymentReference / MpesaReceipt | **P** G5 only |

**Payment origin exclusivity (proposed invariant):**

- BANK ⇒ `bankTransactionId` set; `mpesaReceiptId` null  
- MPESA ⇒ `mpesaReceiptId` set; `bankTransactionId` null  
- MANUAL ⇒ both provider FKs null; MANUAL metadata required  

Do not require provider IDs on all payments.

---

## 4. Payment-origin invariant and manual duplicate handling

### 4.1 Provenance vs tender

| Concept | Examples |
|---------|----------|
| Origin (how Tycoon learned of the money) | BANK, MPESA, MANUAL |
| Tender (how the payer paid) | cash, cheque, bank transfer, M-PESA, other |

### 4.2 Manual M-PESA vs later automatic receipt

1. Staff records MANUAL payment with tender M-PESA and optional `providerReceiptNumber` evidence field.  
2. Later C2B/Pull upserts `MpesaReceipt` with the **same** provider receipt id.  
3. Processor looks up existing Payment linked by exact `mpesaReceiptId` or an explicit manual-link keyed by provider receipt id.  
4. If a MANUAL payment is already linked: enrich receipt, **do not** create a second Payment/Ledger.  
5. If conflict (different amounts/tenancies): mark receipt for **manual resolution** — no automatic merge on amount/date alone.

Existing source-less Payments are classified only after data review (dry-run), not bulk UPDATE to MANUAL.

---

## 5. Shared reconciliation service contract (proposed)

Input: normalized source reference (`BankTransaction` or future `MpesaReceipt`) + already-resolved `tenancyId` (or explicit unresolved).

Responsibilities:

1. Idempotent: return existing Payment if source already posted.  
2. Load eligible outstanding RentCharges for **that tenancyId only**.  
3. Plan allocation (existing oldest-first utility can remain).  
4. In one Mongo transaction: create Payment + allocations; update charge projections; post Ledger; set source state POSTED + match fields.  
5. Post-commit: SMS/audit (non-financial).

Co-op HTTP payload parsing stays in the Co-op provider. Shared engine never imports Co-op schema modules.

---

## 6. Co-op adapter to shared engine flow

```text
Webhook/Poll → verify Basic credential (as implemented) → resolve BankAccount by account hash
  → normalize → persist BankTransaction (idempotent by provider+providerTransactionId)
  → set state RECEIVED if new / keep FAILED_RETRYABLE if prior fail
  → claim → resolve Tenancy (estate + house ref + timestamp)
  → if unique tenancy: shared reconcile (transaction)
  → else: UNMATCHED / MANUAL_REVIEW
```

**Matching rules (target):**

1. Restrict houses to `BankTransaction.estateId`.  
2. Exact houseNumber or paymentReferences match.  
3. Tenancy where `startAt <= transactionDate < endAt` (or endAt null).  
4. Exactly one → proceed; zero/many → unmatched.  
5. Operator assign supplies `tenancyId`.

Compatibility: continue populating `matchedHouseId` / `matchedTenantId` from the tenancy for old UI; add `matchedTenancyId`.

**Authentication wording:** baseline implements shared-secret equality on header/body Basic fields (`coop.provider.js` `verifyWebhookSignature`). Documents must not call this a cryptographic signature unless implementation changes.

---

## 7. Future M-PESA receipt flow (G5 — not authorized now)

```text
C2B callback or Pull item → upsert MpesaReceipt by shortcode + receipt number
  → resolve TenancyPaymentReference → tenancyId
  → shared reconcile (same engine)
```

- Collection account: one Tycoon client (v1); may cover multiple estates.  
- TenancyPaymentReference: unique within collection account; never recycled; remains mapped after tenancy closes.  
- STK display shortcode is not an assumed C2B sandbox shortcode; explicit simulator verification gate retained.  
- Financial posting blocked until G4 + owner G5 authorization.

---

## 8. RentCharge and PaymentAllocation constraints

**New charges:** always `tenancyId` + denormalized houseId/estateId/clientId.  
**Outstanding query:** by `tenancyId` + open statuses (replace house-only outstanding for allocation).  
**Allocation:** reject if `payment.tenancyId ≠ charge.tenancyId`.  
**Unique charge key (target):** `{ tenancyId, period, chargeType, description }` (house no longer sole uniqueness axis).  
Legacy rows without tenancyId: excluded from automatic allocation to active tenancies.

---

## 9. Ledger and deposit accounting semantics

### 9.1 Single ledger

One `Ledger` collection. Proposed fields:

- `tenancyId` (required on new rent/deposit movements)  
- `accountCategory`: `RENT` | `DEPOSIT`  
- existing entryType, amountCents (signed), references, period  
- optional denormalized houseId/estateId/clientId for aggregates  

### 9.2 Balance derivation (preferred)

**Authoritative balance** for a tenancy + category = aggregate of signed movements, not a house-level running pointer.

If a snapshot field is retained for performance:

- Scope snapshot to `(tenancyId, accountCategory)` only.  
- Serialization: update snapshot **inside** the same Mongo transaction as the inserting movement; on conflict abort/retry transaction.  
- Snapshot must be **rebuildable** from movements; periodic verification job compares sum vs snapshot.  
- **Do not** keep the baseline house-level `runningBalanceCents` algorithm as authority for tenant obligations.

House/estate dashboards: aggregate open ACTIVE tenancies and/or explicit filters for CLOSED historical tenancies — never “latest ledger row for houseId” as current occupant balance.

### 9.3 Deposits

- Deposit document per tenancy.  
- Ledger DEPOSIT_* entry types remain; category DEPOSIT.  
- Never allocate deposit movements as rent payment.  
- Transfer: explicit command reduces source liability and increases destination with audit metadata; single transaction.

### 9.4 RentCharge projections

`amountPaidCents` / `balanceCents` remain rebuildable caches from allocations; rebuild tools required if drift detected.

---

## 10. Billing effective-date rules

- Config applies to billing periods where period start ≥ effectiveFrom and (effectiveTo is null or period start < effectiveTo).  
- Changes take effect at period boundaries; no silent mid-period proration (v1).  
- Service layer prevents overlapping isActive ranges for same house + chargeType (and unique index if data allows).  
- Generated RentCharge stores amount snapshot + `billingConfigId` / version reference.  
- Migration: backfill or accept legacy configs without effectiveTo; enforce going forward.

---

## 11. Transaction boundaries and idempotency

| Operation | Atomic unit |
|-----------|-------------|
| Move-out / move-in | Tenancy close/open + House/Tenant projection updates |
| Charge generate | RentCharge upsert + Ledger CHARGE (RENT) |
| Payment post | Payment + allocations + charge projections + Ledger + source POSTED state |
| Deposit receive/deduct/settle/transfer | Deposit doc + DEPOSIT ledger rows |

**Fail closed** if Mongo multi-document transactions are unavailable — no baseline-style non-transactional fallback for hardened financial paths.

**Idempotency keys:**

- BankTransaction: existing unique `{ provider, providerTransactionId }`  
- Payment: unique sparse `bankTransactionId`; future unique sparse `mpesaReceiptId`  
- Ledger: unique partial on `{ clientId, referenceType, referenceId, entryType }` (retain/adjust as needed)  
- Reconciliation claim: conditional state transition RECEIVED|FAILED_RETRYABLE → CLAIMED with claim token/expiry

---

## 12. Retry, crash recovery and workers

Replace `if (created) reconcile` with:

1. Persist source.  
2. If state in (RECEIVED, FAILED_RETRYABLE) and not POSTED, attempt claim.  
3. Resolve tenancy; if ambiguous, set MANUAL_REVIEW (not retry storm).  
4. Post financials transactionally → POSTED.  
5. On retryable error → FAILED_RETRYABLE; webhook may return 500 only when persistence itself failed (document provider retry semantics deliberately).  
6. Polling/workers scan FAILED_RETRYABLE / stuck CLAIMED past lease.

Crash after persist before post: row remains retryable. Crash after post before response: idempotent read on replay.

Redis: optional job locks only.

---

## 13. API / service impact map (from baseline callers)

Callers of house-scoped balance/outstanding/ensure/postEntry and occupancy pointers must move to tenancy scope. High-impact areas (confirmed names in repo):

| Area | Baseline symbols | Change |
|------|------------------|--------|
| Reconciliation | `reconciliation.service.js` `reconcile`, `applyPayment`, `findHouseByReference` | Estate+tenancy match; tenancy outstanding |
| Manual payment | `payment.service.js` `recordManual`; `payment.controller.js` `create` | origin MANUAL + tenancyId |
| Transactions | `transaction.service.js` `assignToHouse` | Assign tenancy; fix SMS balance source |
| Rent | `rent.service.js` ensure/outstanding/generate | Tenancy charges; effective dates |
| Ledger | `ledger.service.js` postEntry, balanceForHouse/Tenant | Tenancy+category balances |
| Tenant/House | `tenant.service.js` create/update/moveToHouse/get; `house.service.js` get/list | Lifecycle + projection |
| Deposit | `deposit.service.js` | Per-tenancy |
| Reports / SMS / jobs | `report.service.js`, `sms.service.js`, rent/sms/bank jobs | Aggregates vs occupancy balance |
| Webhook / bank | `webhook.routes.js`, `bank.service.js` `storeAndReconcile` | Processing state machine |

Exact line numbers evolve during G3; re-verify against HEAD before coding.

---

## 14. Historical migration classification and dry-run design

**No migration execution in G2.**

Classes: potentially attributable · ambiguous · unattributable · already inconsistent (see PRD).

Dry-run report (read-only) must list candidate rows, evidence fields, proposed tenancyId or “unassigned”, and conflict counts. Human approval before any write migration. Never assign from current `House.tenantId` alone.

---

## 15. Index migration policy

**Forbidden as ordinary startup:** destructive `dropIndex` / blanket `syncIndexes` that remove production indexes without review (`ensureIndexes` behaviour at baseline).

**Target:**

- Versioned migration scripts (additive indexes first).  
- Preflight: detect duplicates that would violate new uniques.  
- Expand-contract for unique key changes (build new index → dual-write/backfill → switch reads → remove old).  
- Rollback notes per migration.  
- App boot may **create missing** indexes if explicitly configured non-destructive; must not drop.

---

## 16. Security, client isolation, estate authorization

Retain clientId on all business documents. Retain `estateFilter` enforcement for staff. Matching and assignment must not cross clientId. Tenancy resolution must respect estate boundaries of the source account. Admin UI: no Mongo ids in browser URLs; API still authenticates and authorizes by server-side session and resource checks.

---

## 17. Test strategy

| Layer | Scope |
|-------|--------|
| Unit | Allocation, money, date, origin invariants, tenancy interval containment, matching pure functions |
| Integration (replica set) | Move transactional integrity; payment post; retry after fail; cross-tenancy allocation rejected; estate isolation; webhook credential; duplicate source |
| Concurrency | Double move-in; payment during move-out; double reconcile workers |
| G4 regression | Full Co-op paths against tenancy engine |
| G5 | M-PESA only after G4 |

G3 cannot claim done without disposable replica-set evidence (or owner risk waiver).

---

## 18. Operational monitoring and recovery

Metrics: sources RECEIVED/CLAIMED/POSTED/FAILED_*; unmatched age; ledger vs charge projection drift; transaction abort rate. Alerts on FAILED_RETRYABLE backlog and stuck CLAIMED. Runbooks: redrive failed sources; rebuild tenancy balance from ledger; manual tenancy assign.

---

## 19. Delivery gates and stop/go

| Gate | Go criteria |
|------|-------------|
| G2 | Owners accept this design freeze |
| G3 | Design approved; replica-set test env; implement Tenancy + engine; dry-run migration report; unit+integration evidence; **no** M-PESA post |
| G4 | Co-op webhook/poll/retry/assign/reports/isolation pass on engine |
| G5 | Daraja contract verified; M-PESA models; posting authorized |

**Stop:** Any proposal to post M-PESA before G4, or to guess legacy tenancy from current house occupant.

---

## 20. Self-critique and residual risks

### 20.1 Challenge answers

1. **Several tenancies per tenant** — Supported. Risk: UI assumes one house per tenant. Mitigation: list tenancies explicitly; optional product limit later. **In design.**  
2. **Concurrent occupy same house** — Partial unique + transaction. Test: parallel move-in. **In design.**  
3. **Payment during move-out** — Match uses tenancy active at transactionDate; posting transaction reads tenancy immutably. Test: interleave move-out and webhook. **In design.**  
4. **Late Co-op pay after move-out, house ref only** — Unmatched until operator selects tenancy. **In design.**  
5. **Manual M-PESA then auto receipt** — Exact provider receipt link; no amount-only merge. **In design.**  
6. **Crash after persist** — Retryable states; idempotent post. **In design.**  
7. **Concurrent payments corrupt balance** — Mongo transaction + tenancy-scoped snapshot protocol or pure aggregate reads. Test: parallel payments. **In design.**  
8. **RentCharge without Ledger** — Same transaction; no swallow-all catch. Test: forced ledger failure aborts charge. **In design.**  
9. **Deposit transfer vs rent** — Category DEPOSIT; explicit transfer API. **In design.**  
10. **Ambiguous history** — Unattributed class; excluded from auto allocation. **In design.**  
11. **Dashboards blending occupants** — Aggregates by tenancy status; current balance = active tenancy only. **In design.**  
12. **Mid-month config change** — Period boundary only. **In design.**  
13. **Unique indexes vs production data** — Preflight mandatory; may block unique creation. **Owner/data dependency.**  
14. **Over-engineering risk** — Full event-sourced accounting subledger deferred; single ledger + categories enough. Claim tokens kept minimal. **Simplified in design.**  
15. **Missing rules** — Partial payments across many charges already exist; refunds/reversals need explicit G3 test matrix; multi-currency out of scope; grace periods not specified. **Residual — owner/product.**

### 20.2 Changes after self-critique

- Rejected house-level running balance as ongoing authority.  
- Rejected `created === true` as sole reconcile gate.  
- Rejected tenant-lifetime deposit.  
- Rejected automatic legacy backfill.  
- Kept Co-op transport intact; limited changes to shared engine and match scope.  
- Explicit fail-closed transactions.  
- Explicit non-destructive index policy.

### 20.3 Residual risks

| Risk | Severity | Notes |
|------|----------|-------|
| Production data blocks new uniques | High | Dry-run preflight |
| Incomplete integration tests in G3 | High | Env dependency |
| Caller migration misses a house-scoped path | High | Impact map + search gates |
| Operator load for unmatched historical payments | Medium | UX decision |
| Snapshot vs aggregate performance | Low–Med | Measure before adding caches |

---

## Document control

Aligned with `PRD.md` and `architecture-summary.md` at G2 (2026-11-07). Code baseline SHA preserved. No implementation authorized by this revision alone.

## 21. Runtime implementation reconciliation (2026-11-10)

The G2 baseline at `569c96c` is historical. The current repository has since
introduced Tenancy, origin-aware Payments, allocation serialization, tenancy-
scoped ledger posting, live index-readiness inspection, and guarded migration
scripts. The design documents remain constraints and intent; they must not be
used as a substitute for inspecting current source, tests, runtime output, and
the actual database before diagnosing a failure. This addendum does not claim
that G3/G4 acceptance is complete.

### 21.1 Allocation totals

- `PaymentAllocation` is the canonical source for allocation totals.
- `Payment.allocatedCents` remains a deprecated denormalized compatibility
  field in the present schema/writer path. It is not an accounting authority.
- Startup integrity verification checks allocation structure and ownership,
  not equality between `allocatedCents` and the sum of allocation rows.
- Structural invariants remain enforced: safe positive allocation amounts,
  receipt capacity, client/estate/house/tenancy consistency, existing charge
  references, and absence of orphan allocations.
- No automatic counter backfill is part of application startup.

### 21.2 Readiness boundaries

`connectDatabase()` should fail startup for an unavailable database, failed
transaction-topology verification where required, or genuine allocation
structural-integrity failures. It should not fail because a deprecated cached
counter is stale.

Financial index readiness remains independent. `ensureIndexes()` may create
ordinary schema-declared operational indexes, but financial identity indexes
remain explicit-migration-owned. A missing or misaligned RentCharge,
HouseType, or MANUAL payment-reference index keeps financial posting disabled;
it does not require terminating the HTTP server. Posting services must retain
their own live index and transaction checks.

### 21.3 Exact historical RentCharge index recognition

The historical house-scoped unique index was declared with the key
`{ clientId: 1, houseId: 1, period: 1, chargeType: 1, description: 1 }`
without an explicit name. MongoDB therefore reports the generated name
`clientId_1_houseId_1_period_1_chargeType_1_description_1`. The readiness and
migration classifiers must recognize this exact verified key/name pair as the
known obsolete index, while continuing to reject unknown unique indexes that
contain `houseId`, or indexes whose uniqueness options/key pattern differ.
Recognition is classification only. The explicit migration still performs
duplicate and malformed-record preflight, installs and verifies the target
tenancy-scoped partial unique index, and only then drops the verified old index.

### 21.4 Data provenance

Schema compatibility is not equivalent to financial truth. Development seed
records, stale legacy projections, and genuine historical transactions are
different data classes. Missing new fields alone do not justify assigning
Tenancy ownership, changing charge status, manufacturing allocations, or
posting ledger entries. Review provenance and the actual write path first;
keep uncertain rows unchanged until an explicit disposition is approved.
