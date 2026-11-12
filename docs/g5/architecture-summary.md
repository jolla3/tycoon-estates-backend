# G5 — Architecture Summary and Engineering Handoff

**State:** Revised G5.0 design baseline. G5 code does not exist.

**Workspace verification (2026-11-12 construction init):**
- Repository `https://github.com/jolla3/tycoon-estates-backend`, branch `main`.
- Verified HEAD still `204c8f9c3578f753af20727799aaa049b1545135` (`feat(banking): integrate verified G4 banking infrastructure`, 2026-11-12). Same as the design-audit baseline — no post-audit main drift detected at init.
- Remote `origin/main` matched local HEAD; clone working tree was clean.
- Confirmed in current source: `Payment.origin` includes `MPESA` and `mpesaReceiptId` ObjectId unique partial index exists; `accountingPosting.service.js` still has no MPESA posting branch; no `Mpesa*` models; no Daraja/Safaricom client code; SMS path remains Celcom outbound via `sms.service.js`; G4 banking providers present (`COOP` + disabled shells).
- Construction workspace: `/home/workdir/artifacts/G5` (application tree + G5 docs). Implementation is **not** authorized until explicit G5.1 approval.

  
**Repository:** `jolla3/tycoon-estates-backend`  
**Source-audit snapshot:** `main` at `204c8f9c3578f753af20727799aaa049b1545135` (12 November 2026)  
**Read order:** this summary → `PRD.md` → `architecture.md` → `G5_IMPLEMENTATION_GUARDRAILS.md`.

## Product in one paragraph

G5 attributes ordinary customer-to-merchant M-PESA Buy Goods / Till rent receipts to one immutable tenancy. A private tenancy-bound link lets the tenant or a third party submit the complete M-PESA confirmation SMS. Tycoon independently verifies that evidence against the merchant's Daraja C2B callback/Pull Transactions record, converges both channels to one canonical transaction, then posts once through G3. The Till receives the money. G5 does not move funds.

## Scope boundary

- Buy Goods / Till only.
- PayBill reference collection is not being redesigned and must not be changed.
- No STK Push, outbound B2B/B2C, withdrawals, merchant settlement, or bank reconciliation redesign.
- G4 bank integration remains separate.
- G3 remains the only Payment / allocation / rent charge / Ledger authority.

## Non-negotiable invariants

1. **Tenancy identity:** the private link stores the exact `Tenancy._id` and immutable ownership scope. Never infer the historical tenancy from current `Tenant` or `House` pointers.
2. **Third-party payer:** the link identifies the intended tenancy, not the human submitter. Payer MSISDN need not equal tenant phone.
3. **Secret handling:** token has at least 256 bits of randomness; the database stores only its hash/digest. The temporary SMS payload is encrypted and excluded from API/history/log surfaces. Secret rotation/revocation does not change the tenancy binding.
4. **Two independent evidence sources:** automatic posting requires a submitted confirmation SMS and a matching canonical Daraja merchant transaction. SMS alone and callback alone are insufficient.
5. **One transaction identity:** callback and Pull Transactions use one normalization/upsert path and one unique `(merchantProfileId, receiptNumber)` canonical record.
6. **One receipt, one payment:** MongoDB uniqueness and transaction checks prevent a canonical receipt from posting more than once or switching tenancies.
7. **G3 only:** `Payment.origin = 'MPESA'`; `Payment.mpesaReceiptId` is an ObjectId reference to `MpesaTransaction._id`, never the external receipt string. Extend `accountingPosting.service.js`; do not create a parallel ledger.
8. **Atomic financial effect:** Payment, allocations, charge projections, Ledger PAYMENT, and claim/transaction POSTED state commit or roll back in one MongoDB transaction.
9. **Closed tenancy:** late payment uses the original link-bound tenancy and only its already-existing eligible charges. No new old-tenancy charges, no credit transfer to a new tenancy. Unapplied amount remains old-tenancy credit or goes to review if G3 cannot safely represent it.
10. **G4 isolation:** do not change the shared `tenancyContains()` rule or G4 bank reconciliation to accommodate G5 arrears.
11. **Unknown means blocked:** no invented Daraja methods, payload fields, signatures, callback acknowledgments, merchant mappings, timestamp tolerance, or enablement claims.
12. **Preservation:** never reset, clean, force-push, broad-restore, or overwrite unrelated work. Narrow changes only.

## Source-audit findings at the pinned snapshot

- Stack: Node.js ESM, Express 4, Mongoose 8, MongoDB transactions, Redis coordination, Jest.
- `Tenancy` represents historical occupancy and includes `ACTIVE`, `CLOSED`, `VOID`, `startAt`, `endAt`, and `ledgerRev`.
- `tenancyContains()` enforces `startAt <= eventTime < endAt`; G4 bank reconciliation uses it. G5 must not weaken it.
- `Payment.origin` already permits `MPESA`. `Payment.mpesaReceiptId` is an ObjectId field with a unique partial index for ObjectId values. The shared posting service does not yet implement the MPESA idempotency/linkage path.
- G3 shared posting already writes Payment, allocations, charge projections and Ledger in a Mongo transaction, validates supplied charges against the exact tenancy, and uses tenancy/allocation serialization controls.
- `ledgerService.postEntry()` accepts tenancy-scoped rent PAYMENT entries with an exact Payment reference and Mongo session; it does not itself require the Tenancy to be ACTIVE. This does **not** prove that every closed-tenancy/overpayment path is ready; see blockers.
- `tenantService.create()` creates Tenant + Tenancy in one transaction. `tenancyService.moveToHouse()` also uses a transaction.
- `tenantService.update(status='moved_out')` currently updates Tenant status and closes the Tenancy separately. G5 must not attach link state to that non-atomic path without fixing/centralizing the transaction boundary.
- `SmsMessage.message` is plaintext in the current implementation and is returned in tenant/SMS history paths. A token-bearing URL must not be put there without a protected encrypted payload and redaction change.
- G4 bank models are provider-specific and must not be repurposed as M-PESA records.
- G3/G4 have useful patterns for guarded indexes, durable ingestion, claims/quarantine, Redis scheduler locks and audit. Adapt patterns; do not transplant bank domain models.

**Audit limitation:** this is a pinned source snapshot, not a guarantee that `main` still has the same HEAD. Re-fetch GitHub before implementation and re-audit changed files. No G5 tests, migrations, Daraja sandbox calls, or production transactions were run in G5.0.

## Proposed G5 domain records

- `MpesaMerchantProfile`: Daraja application/merchant configuration and verified client/estate/store ownership mapping.
- `MpesaSubmissionLink`: token hash, exact historical tenancy snapshot, lifecycle state, revocation/rotation metadata.
- `MpesaSmsSubmission`: encrypted original message if retention is approved, digest, parsed normalized evidence, parser version and state.
- `MpesaTransaction`: one normalized provider receipt per merchant profile, independent ingestion provenance and posting state.
- `MpesaPaymentClaim`: claim between one SMS/link and one canonical M-PESA transaction; fenced state and G3 posting reference.
- `MpesaCallbackEvent`: durable callback inbox/quarantine, idempotency metadata and redacted/encrypted evidence as required.

Exact schema fields, key patterns and migration definitions are provisional until current source and the real Daraja payloads are re-verified.

## Lifecycle and accounting rules

- Create link + protected notification outbox in the same transaction as the exact Tenancy.
- Send SMS only after commit through the existing scheduler-driven Celcom queue drain (not a dedicated worker process).
- On move, create a new link for the new Tenancy; old link becomes `ARREARS_ONLY` when debt or claims may remain. Never reassign it.
- Closed-tenancy payments use `link.tenancyId`; allocate only to existing charges of that same Tenancy. Do not invoke the bank date-based tenancy rule and do not create new charges.
- Excess payment cannot be lost or transferred. Prove G3's unapplied-credit behaviour before automatic overpayment posting; otherwise review.
- Link becomes `SETTLED` only after verified historical ledger coverage, all obligations resolved, no unresolved credit, and no open claims. `UNVERIFIED` coverage means non-terminal/review.

## Blocking gates

The PRD lists ten numbered blockers. The most important are: actual Till/Store/Head Office hierarchy; authenticated Daraja callback and Pull contract; merchant-specific enablement; timestamp comparison tolerance; SMS/PII retention; G3 overpayment representation; historical ledger coverage; Celcom `unknown` delivery recovery; credential ownership; and whether any admin exception can bypass submitted SMS evidence.

Until proven, the safe behaviour is: profile not operational, transaction not auto-matched, claim pending/review, and no G3 posting.

## Required agent workflow

1. Read all four G5 documents.
2. Fetch current repository HEAD and compare it with the pinned audit snapshot. Preserve all local changes.
3. Produce an evidence matrix: verified source facts, product decisions, official provider facts, actual account/sandbox facts, assumptions, and blockers.
4. Independently critique the plan: what breaks, race conditions, missing indexes/migrations, security leaks, overengineering, and requirements the current G3 contracts cannot satisfy.
5. Update PRD, architecture, summary, and guardrails together if the review finds a supported correction. Never promote an assumption into a fact.
6. Stop and request owner decisions for blocking product/business items. Do not write application code in the review pass.
7. After explicit implementation authorization, implement one narrow G5 slice at a time with focused tests and evidence. Keep G3 BANK/MANUAL and G4 regressions intact.

**First review deliverable:** a written critique and revised documents only. No code, migrations, credential changes, provider registration, or deployment.


## G5.0.2 follow-up review (12 November 2026)

The second source review confirmed several additional implementation constraints:

- **G3 credit:** G3 already records the full Payment in the exact tenancy Ledger. Positive `knownCreditCents` is exposed; house projections keep arrears/credits grouped by Tenancy rather than netting across occupancies. Overpayment can be applied to a final charge as `OVERPAID`, or remain unapplied when no eligible charges exist. This is an existing accounting representation, not approval to refund, spend or transfer credit. B06 remains open for owner policy and closed-tenancy tests.
- **Historical coverage:** `ledgerService.balanceForTenancy()` currently always reports `UNVERIFIED` and `verifiedFullObligation: false`. The current helper cannot authorize `SETTLED`.
- **Public route:** the ordinary API router is behind CSRF protection; only signup/login are exempt. The global JSON parser runs before routes with a 1 MB limit. The Redis rate limiter fails open on outages. The public bearer submission route therefore needs a narrowly mounted pre-CSRF/pre-auth path, a strict body parser applied before the global parser, and an explicit limiter outage policy. It must not be placed in the provider webhook namespace.
- **SMS delivery:** the current queue drain runs inside `smsReminderJob` every 15 minutes from the API-process scheduler; it is not a dedicated worker process. Claimed jobs left in `processing` are not reclaimed by the current queue path. Celcom `unknown` remains ambiguous and must not be blindly resent.
- **Tenant lifecycle:** the moved-out path updates Tenant and closes Tenancy in separate operations; make it atomic before G5 lifecycle hooks. The demo seed script opens Tenancies directly and must never cause real link SMS delivery.
- **Protected outbox:** existing `queueSms()` and `withIdempotency()` do not accept a Mongo session; they cannot be called unchanged for transactionally atomic G5 onboarding.

New technical design gates G5-D13–D15 are recorded in the PRD and architecture: public endpoint security/middleware order, SMS dispatch recovery/SLA, and tenancy lifecycle/seed policy. No application code or migrations were changed and no G5 tests were run.


## Current next gate: G5.1 schema/index design

The proposed five-record schema and index decision record is [G5_1_SCHEMA_INDEX_DESIGN.md](G5_1_SCHEMA_INDEX_DESIGN.md).

**Status:** GO for documentation/design review only. NO-GO for application implementation or migrations.

The initial proposal omits a separate PaymentClaim collection: the canonical MpesaTransaction owns its one-winning claim and fenced posting state. A generic provider-ingestion inbox handles callback durability/quarantine; Pull checkpoint schema is deferred until the authenticated contract defines the checkpoint unit. Merchant identity and receipt uniqueness remain provisional under B01/B02, credentials under B09, and retention under B05.

Source of truth for G5 documentation and shared review is the live GitHub feature branch accessed through Composio. A hosted agent's local workbench may be stale or divergent and must be reconciled without destructive Git operations.
