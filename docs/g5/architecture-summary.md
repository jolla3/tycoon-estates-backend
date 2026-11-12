# G5 — Architecture Summary and Engineering Handoff

**State:** G5.1.1 corrected design baseline. G5 code does not exist.

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
5. **One transaction identity:** callback and Pull Transactions use one normalization/upsert path and one canonical `(merchantProfileId, receiptNumber)` record only after B01/B02 prove that scope and the exact unique index is installed and verified. Before that, duplicate candidates remain quarantined and non-postable.
6. **One receipt, one payment:** the external receipt unique index prevents duplicate canonical records; `Payment.mpesaReceiptId` separately prevents two Payments referencing one internal transaction `_id`. The latter alone cannot prevent duplicate external receipts across two transaction documents.
7. **G3 only:** `Payment.origin = 'MPESA'`; `Payment.mpesaReceiptId` is an ObjectId reference to `MpesaTransaction._id`, never the external receipt string. Extend `accountingPosting.service.js`; do not create a parallel ledger.
8. **Atomic financial effect:** Payment, allocations, charge projections, Ledger PAYMENT, and transaction `paymentId`/POSTED state commit or roll back in one MongoDB transaction. The transaction claim is stored on `MpesaTransaction`, not a separate claim collection.
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
- `MpesaIngestionEvent`: durable callback/Pull inbox and quarantine, source identity/digest, normalized transaction link, and fenced processing lease.
- `MpesaTransaction`: one normalized provider receipt per verified merchant profile, winning claim fields, posting lease/state, and G3 Payment reference. There is no separate `MpesaPaymentClaim` record in the initial five-record model.

Exact schema fields, key patterns and migration definitions are provisional until current source and the real Daraja payloads are re-verified.

## Lifecycle and accounting rules

- Create link + protected notification outbox in the same transaction as the exact Tenancy.
- Send SMS only after commit through the existing scheduler-driven Celcom queue drain (not a dedicated worker process).
- An accepted public submission must conditionally write the same link document using its current token hash/version and increment `submissionRevision` inside the submission transaction; token rotation/revocation must write that same document.
- Ingestion and posting workers use separate write-bearing leases/fencing tokens; no read-only lease check can authorize financial posting.
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


## Previous gate: G5.1 schema/index design

The five-record schema/index decision record is [G5_1_SCHEMA_INDEX_DESIGN.md](G5_1_SCHEMA_INDEX_DESIGN.md).

**G5.1 status:** CONDITIONAL GO for corrected documentation/design only. NO-GO for application implementation or migrations.

The initial proposal omits a separate PaymentClaim collection: the canonical MpesaTransaction owns its one-winning claim and fenced posting state. A generic MpesaIngestionEvent inbox handles callback/Pull durability and quarantine; Pull checkpoint schema is deferred until the authenticated contract defines the checkpoint unit. Merchant identity and receipt uniqueness remain provisional under B01/B02, credentials under B09, and retention under B05. MPESA financial posting is disabled until the exact provider-scoped receipt unique index is installed and runtime-verified; the Payment ObjectId index alone cannot prove external receipt uniqueness.

## Current next gate: G5.2 tenancy link and protected notification lifecycle

The proposed lifecycle/outbox decision record is [G5_2_TENANCY_LINK_AND_OUTBOX_DESIGN.md](G5_2_TENANCY_LINK_AND_OUTBOX_DESIGN.md).

**Independent review verdict:** APPROVE WITH REQUIRED CHANGES; the corrections are recorded below and in G5_2_TENANCY_LINK_AND_OUTBOX_DESIGN.md §16. **Implementation:** NO-GO for application changes, models, migrations, keys, workers or Celcom sends without separate bounded owner authorization.

G5.2 keeps the existing Celcom queue/provider, but extends it with session-aware protected enqueue, a versioned encrypted payload, API/history redaction, dispatch lease fencing and conservative crash recovery. Tenant/Tenancy/link/outbox/critical audit commit together when trusted G5 provisioning is REQUIRED; DISABLED creates no new link/outbox but still transitions any old link when its Tenancy closes/transfers. `moved_out` must become atomic; move must accept a caller-owned session; demo SMS must be explicitly suppressed. Move/move-out requests require an exact expected Tenancy ID supplied by the authenticated tenant detail `currentTenancyId` field. B01/B03 merchant readiness, B05 inbound evidence retention, D17 protected outbox retention, B08 unknown-send recovery and D14 delivery SLA remain unresolved. D18 also requires an API contract change to expose and return exact expected Tenancy IDs.

Source of truth for G5 documentation and shared review is the live GitHub feature branch accessed through Composio. A hosted agent's local workbench may be stale or divergent and must be reconciled without destructive Git operations.

## G5.1.1 independent schema review follow-up (12 November 2026)

The independent review supported the five-record model and conditional claim-on-`MpesaTransaction` approach, but the repository handoff was not fully synchronized. This revision records the following corrections:

- `MpesaIngestionEvent` collection spelling is corrected to `mpesaingestionevents`. The transaction collection name `mpesatransactions` was already correct; the review's alternative `mpesatransed` was an erroneous report typo and was not adopted.
- Removed the separate `MpesaPaymentClaim` and `MpesaCallbackEvent` aggregates from architecture diagrams, field/state descriptions, and index matrices. Callback and Pull ingress share `MpesaIngestionEvent`; the winning claim resides on the canonical transaction.
- Removed the unbounded `sourceEventIds[]` reverse array. Source events retain `normalizedTransactionId`.
- `Payment.mpesaReceiptId` protects one Payment per internal `MpesaTransaction._id`; it does not prevent duplicate internal transaction documents for one physical M-PESA receipt. Therefore posting is fail-closed until B01/B02 prove the external receipt identity scope and the exact provider-scoped unique index passes runtime readiness.
- Link submission versus rotation/revocation now requires a write-bearing conditional update on the same link document inside the submission transaction. A read-only token-version recheck is insufficient under snapshot reads.
- Ingestion-event processing has its own reclaimable lease. Transaction posting has a separate fencing token and a write-bearing conditional operation in the same G3 session. Lease expiry semantics are defined as takeover eligibility, not cancellation of a transaction that already holds the document write fence.
- `claimState` no longer duplicates `POSTED`; posting completion belongs to `postingState`. SHA-256 of a uniformly random 256-bit token is the default; HMAC pepper is not presumed easier to rotate.

**Review outcome:** CONDITIONAL GO for the corrected G5.1 design record. Application implementation and migrations remain NO-GO. No code, database, migration, provider, or test environment was changed or exercised by this review.

## G5.2 source review (12 November 2026)

The implementation source was rechecked at `main@204c8f9c3578f753af20727799aaa049b1545135`. Findings and the proposed lifecycle/outbox state machine are recorded in `G5_2_TENANCY_LINK_AND_OUTBOX_DESIGN.md`.

- `tenantService.create()` already creates Tenant + Tenancy in one Mongo transaction, but `tenantController.create()` does not pass the actor ID accepted by the service. `tenantController.moveToHouse()` also omits the actor argument accepted by its service, and the move-out update path currently has no actor parameter. G5 critical audit requires explicit actor propagation from the authenticated controller into the lifecycle use case.
- `tenantService.create()` already creates Tenant + Tenancy in one Mongo transaction. `tenancyService.moveToHouse()` also has a transaction, but owns its session and clears the old House pointer without matching the expected old Tenant; G5 must make it caller-session-aware and compare the exact pointer so stale moves cannot clear another occupant.
- `tenantService.update(status='moved_out')` still writes Tenant before a separate Tenancy close. Its fallback may unconditionally clear a House pointer when it cannot find the expected active old tenancy, potentially affecting a later occupant. `tenantService.get()` also omits the active Tenancy ID it uses internally. G5.2 requires an exact `currentTenancyId` DTO, expected-Tenancy request preconditions and a House pointer compare before any clear. The operation must become one transaction before G5 lifecycle state is attached.
- `queueSms()` and `withIdempotency()` do not accept a Mongo session. Protected onboarding needs a session-aware insert into the existing SmsMessage queue, not a second queue.
- SmsMessage body and phone are currently ordinary fields exposed through SMS history/tenant details. G5 destination/body must live in an authenticated, versioned encrypted envelope; default API/history/serialization paths must redact it.
- The worker has no stale-`processing` reclaimer. G5 requires a fenced dispatch lease and a durable `sendStartedAt` boundary; only pre-send expired leases can be safely reclaimed. After send-start, an expired/ambiguous result is `unknown` and cannot be blindly resent. The Celcom adapter accepts only mobile/message and ignores the third idempotency argument passed by the generic service; no provider-level idempotency is established.
- `seedDemoClient.js` inserts “not sent” sample SMS records as `queued`, which the scheduled 15-minute drain can dispatch. Seed rows must be suppressed and excluded by the atomic worker claim query.
- MongoDB `withTransaction()` may retry its callback. Preallocate stable identifiers, token/version and idempotency key, and pin the outbox key version before the callback. Generate a fresh GCM nonce/envelope inside each callback attempt; only the committed envelope can be dispatched, and no Celcom I/O occurs inside the callback.

**G5.2 status:** PROPOSED for independent design review. No application code, model, migration, key, provider or test environment was changed or exercised.

## G5.2.1 independent review resolution (12 November 2026)

Grok's independent verdict was **APPROVE WITH REQUIRED CHANGES**. Corrections are normative in G5_2_TENANCY_LINK_AND_OUTBOX_DESIGN.md §16.

- Exact expected Tenancy IDs are mandatory. Old-House pointer clear and tenancyService.close() require exact tenant match plus matchedCount === 1. Any non-null destination House pointer conflicts.
- Move-out is one transaction. An already CLOSED MOVE_OUT expected Tenancy is an idempotent no-op and cannot affect a later occupant. currentTenancyId requires exactly one tenant-scoped ACTIVE Tenancy plus Tenant/House integrity checks.
- Add g5_onboarding_link, cancelled and suppressed to strict SMS enums before use. Standard claim allows only deliveryMode absent or STANDARD and dispatchMode absent or SEND; explicit null/malformed values are excluded. Protected claim requires exact G5_PROTECTED + SEND.
- Pre-send lease expiry may requeue only after link validation; post-send-start expiry becomes unknown, never auto-retry. All transitions are fenced by the current attempt token.
- submissionRevision, dispatchRevision, tokenVersion and notificationVersion are distinct. Send-start uses the observed dispatchRevision CAS paired with the SMS write.
- Live SMS unique-index state is unverified; preflight it. Celcom does not provide idempotency through the ignored third argument. Seed fixtures require suppressed status/mode and zero provider calls.
- D11 records the in-flight stale-URL risk; D14, B08 and D17 remain unresolved. B09 concerns Daraja API credentials, not non-secret Till instructions.

**Current gate:** documentation correction complete; G5.2 implementation remains NO-GO pending explicit bounded owner authorization and relevant operational decisions.

## G5.2.2 full lifecycle audit (12 November 2026)

All 157 pinned src/ JavaScript files, 21 scripts/ JavaScript files and 57 JavaScript tests were fetched and scanned without errors. No hidden raw collection/bulk-write occupancy writer was found. Accounting Tenancy.updateOne() calls only increment ledgerRev.

Two missed API paths are now explicit: House PATCH can change occupancy status/isActive without checking a live Tenancy, and Tenant PATCH can set status active without opening a Tenancy. tenancyService.open() also needs exact Tenant/House/Estate checks, matched-count enforcement and a Tenant-wide ACTIVE uniqueness barrier. See G5-D19/D20, G5.2 §17 and the proposed G5.1 partial index.

**Implementation remains NO-GO.** Remove generic occupancy mutation and harden the existing lifecycle primitive before adding G5 link/outbox hooks.
