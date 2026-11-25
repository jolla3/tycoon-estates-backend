# G5 — Architecture Summary and Engineering Handoff

## Current authoritative handoff — G5.5 C2B-first readiness (23 November 2026)

**Current position:** M-PESA has implemented profile creation, shared callback configuration, C2B/Pull registration attempts, durable ingress, canonical receipt records and gated posting code. The end-to-end C2B collection-to-G3 path is NOT yet proven operational. Do not describe M-PESA as production-ready.

### Locked direction

- C2B is the primary collection path. Pull is optional recovery/reconciliation and must not block C2B activation.
- Profile creation starts DRAFT and changes configuration only. C2B registration acceptance updates registration evidence only; it does not verify callback delivery or set ACTIVE.
- operationalState=ACTIVE requires explicit audited server-side activation after exact-shortcode C2B callback delivery, safe callback trust, durable ingress, correct normalization, duplicate handling and current callback-config evidence pass.
- C2B operational readiness is separate from G3 automatic posting. Posting stays blocked by callback trust, canonical receipt identity/index, exact attribution, transaction/idempotency, database and accounting gates.
- PULL UNKNOWN or NOT_ENABLED is a normal state for a C2B-only merchant. Pull is enabled only after merchant/environment eligibility, nominated KYC number, registration, query, actual Buy Goods row and pagination/reconciliation evidence are proven.
- The callback's shortcode is a lookup key, not authentication. The current provider evidence does not establish a Daraja signature/HMAC/auth header. External C2B validation is not enabled, and the current handler's unconditional Accept response is a defect to fix before exposure.

### Current profile evidence supplied by owner

As shown in the Superadmin UI on 22 November 2026, both profiles have C2B URL registration confirmed under shared daraja-sandbox callback configuration version d3c06c1df7e7:
- mamba, Buy Goods Till 8965322: callback UNKNOWN, Pull UNKNOWN, Pull not registered; masked nominated number captured.
- Safaricom Sandbox Till, Buy Goods Till 600995: callback UNKNOWN, Pull UNKNOWN, Pull not registered; nominated number not captured.

These screen values are owner-reported registration evidence, not proof of a delivered callback or a live collection. Do not equate these shortcodes with historical 600987 or 174379 without provider evidence.

### Current source blockers

1. mpesaBlockers() currently treats Pull capability and Pull registration as mandatory for every profile. This is inconsistent with the C2B-first product and with the backend's own fail-closed Pull eligibility map.
2. There is no platform API operation for explicit activate/suspend/resume.
3. handleC2bValidation() accepts every request even though external validation is not enabled. Keep the route disabled/fail-closed until provider enablement and validation behaviour are verified.
4. The callback routes are feature-gated; earlier evidence records the deployed callback as not exposed. No owner evidence supplied here proves an end-to-end callback simulation for either current profile.
5. Canonical external receipt identity remains hardcoded false; automatic G3 posting remains blocked.
6. Pull pagination terminal semantics remain unresolved; the current scheduled worker does not implement a proven full-page sequence.

### Required delivery order

G5.5: implement capability-specific readiness and audited server-owned lifecycle transitions, plus tests proving Pull absence does not block C2B.
G5.6: controlled sandbox callback proof for each exact profile/shortcode; verify durable inbox, replay/conflict handling and exact merchant resolution.
G5.7: resolve callback trust and canonical receipt identity, then implement the migration-controlled index only after duplicate preflight and provider evidence.
G5.8: enable G3 posting only after exact attribution, G3 tenant credit, atomicity, transaction indexes and replica-set tests pass.
G5.9: separately finish optional Pull eligibility, registration, query, pagination and C2B convergence.

### Hard holds

No production callback exposure, production provider requests, Pull registration, real-tenant sandbox posting, migrations, or financial feature-flag changes are authorized by this documentation update. No code or database state has been changed.

---


**State (2026-11-14, `main` at `5a96f124f45b7f556fc467eb65dbf1bc87413f88`):** G5.3 ingestion and Tenant collection code is published; this patch adds the owner-supplied C2B v2/Pull contract corrections. Not production ready; callback exposure and money-moving capabilities remain gated.

### Operational handoff (short)

| Area | Status |
|---|---|
| Code published | Submission link lifecycle, public submission API, deterministic SMS parser, evidence envelope, Tenant credit + cross-Tenancy oldest-first settlement, fenced receipt posting service, protected SMS outbox, authenticated Tenant account / review APIs, guarded migrations, OpenAPI entries. |
| Verified by executed tests | The pre-contract-correction candidate `0df6f23` passed 24 focused unit suites / 116 tests and 2 MongoDB replica-set G5 integration suites / 9 tests. This was a focused G5/regression set, not the full repository suite. |
| Current contract-correction tests | New C2B v2/Pull response, normalization, registration and request-contract tests are added in this patch; they must be run before merge/deploy. |
| NOT executed | Full repository Jest suite and production migrations. |
| Disabled by default | `G5_SUBMISSIONS_ENABLED`, `G5_MPESA_POSTING_ENABLED`, `G5_PROTECTED_SMS_ENABLED`, `G5_SMS_EVIDENCE_RETENTION_APPROVED`. Posting additionally hard-blocked while canonical receipt identity (B01/B02) is unproven. |
| Unresolved gates | B01-B05, B07-B10 (provider/owner evidence). Nothing here resolves them. |
| Migrations | `20261113_g5_payment_receipt_tenancy_index.js`, `20261113_g5_collection_indexes.js`: dry-run default, allowlisted `--execute`; never run against staging/production by this work. |
| Remaining work | Public frontend page (`/pay#t=`), real SMS-capture fixtures (B04), retention/recovery policy (B05), override policy (B10), running integration tests, enabling flags per environment after approvals. |

Details and decisions: `architecture.md` (section 23 and the G5 collection design record `G5_COLLECTION_IMPLEMENTATION_DESIGN.md`).

---


**Historical workspace verification (2026-11-12 construction init; superseded by the state above):**
- Repository `https://github.com/jolla3/tycoon-estates-backend`, branch `main`.
- Verified HEAD still `204c8f9c3578f753af20727799aaa049b1545135` (`feat(banking): integrate verified G4 banking infrastructure`, 2026-11-12). Same as the design-audit baseline — no post-audit main drift detected at init.
- Remote `origin/main` matched local HEAD; clone working tree was clean.
- Confirmed in current source: `Payment.origin` includes `MPESA` and `mpesaReceiptId` ObjectId unique partial index exists; `accountingPosting.service.js` still has no MPESA posting branch; no `Mpesa*` models; no Daraja/Safaricom client code; SMS path remains Celcom outbound via `sms.service.js`; G4 banking providers present (`COOP` + disabled shells).
- Construction workspace: `/home/workdir/artifacts/G5` (application tree + G5 docs). (Historical statement at init time; construction has since proceeded on `feature/g5-construction`.)

  
**Repository:** `jolla3/tycoon-estates-backend`  
**Source-audit snapshot:** `main` at `204c8f9c3578f753af20727799aaa049b1545135` (12 November 2026)  
**Read order:** this summary → `PRD.md` → `architecture.md` → `G5_IMPLEMENTATION_GUARDRAILS.md`.

## Product in one paragraph

G5 attributes ordinary customer-to-merchant M-PESA Buy Goods / Till rent receipts to one Tenant identity. A private Tenant-level link lets the tenant or a third party submit the complete confirmation SMS. Tycoon verifies the receipt against merchant-side Daraja C2B callback/Pull records, claims it once, and posts Tenancy-scoped G3 allocations. A single-unit Tenant sees one account; a multi-unit Tenant in one Estate sees a combined statement. Surplus remains as G3-owned Tenant credit for future rent. The Till receives the money; G5 does not move funds.

## Scope boundary

- Buy Goods / Till only.
- PayBill reference collection is not being redesigned and must not be changed.
- No STK Push, outbound B2B/B2C, withdrawals, merchant settlement, or bank reconciliation redesign.
- G4 bank integration remains separate.
- G3 remains the only Payment / allocation / rent charge / Ledger authority.

## Non-negotiable invariants

1. **Tenant identity:** the private link stores immutable `{ clientId, estateId, tenantId }`. Resolve all eligible Tenancies after token validation; never infer occupancy from one current House pointer.
2. **Third-party payer:** the link identifies the Tenant account, not the human submitter. Payer MSISDN need not equal Tenant phone.
3. **Secret handling:** token has at least 256 bits of randomness; the database stores only its hash/digest. The temporary SMS payload is encrypted and excluded from API/history/log surfaces. Secret rotation/revocation does not change the tenancy binding.
4. **Two independent evidence sources:** automatic posting requires a submitted confirmation SMS and a matching canonical Daraja merchant transaction. SMS alone and callback alone are insufficient.
5. **One transaction identity:** callback and Pull Transactions use one normalization/upsert path and one canonical `(merchantProfileId, receiptNumber)` record only after B01/B02 prove that scope and the exact unique index is installed and verified. Before that, duplicate candidates remain quarantined and non-postable.
6. **One receipt, one claim:** the external receipt unique index prevents duplicate canonical records. A combined Tenant receipt may create multiple child Payments, one per Tenancy, protected by `{ mpesaReceiptId, tenancyId }`; the canonical receipt claim still occurs only once.
7. **G3 only:** `Payment.origin = 'MPESA'`; `Payment.mpesaReceiptId` is an ObjectId reference to `MpesaTransaction._id`, never the external receipt string. Extend `accountingPosting.service.js`; do not create a parallel ledger.
8. **Atomic financial effect:** all child Payments, allocations, charge projections, Tenancy Ledger entries, Tenant-account credit movement and canonical `paymentIds[]`/POSTED state commit or roll back in one MongoDB transaction. The transaction claim is stored on `MpesaTransaction`, not a separate claim collection.
9. **Closed Tenancy:** a Tenant-level receipt may pay pre-existing eligible charges on that Tenant's closed Tenancies as well as current charges. It never generates new charges for a closed Tenancy. Surplus carries forward as Tenant-account credit in the same Estate.
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
- `MpesaSubmissionLink`: token hash, immutable client/Estate/Tenant identity, lifecycle state, revocation/rotation metadata.
- `MpesaSmsSubmission`: encrypted original message if retention is approved, digest, parsed normalized evidence, parser version and state.
- `MpesaIngestionEvent`: durable callback/Pull inbox and quarantine, source identity/digest, normalized transaction link, and fenced processing lease.
- `MpesaTransaction`: one normalized provider receipt per verified merchant profile, winning claim fields, posting lease/state, and G3 Payment reference. There is no separate `MpesaPaymentClaim` record in the initial five-record model.

Exact schema fields, key patterns and migration definitions are provisional until current source and the real Daraja payloads are re-verified.

## Lifecycle and accounting rules

- Create one Tenant-level link + protected notification outbox in the same transaction as the Tenant's first G5-provisioned lifecycle operation; later unit additions retain that link.
- Send SMS only after commit through the existing scheduler-driven Celcom queue drain (not a dedicated worker process).
- An accepted public submission must conditionally write the same link document using its current token hash/version and increment `submissionRevision` inside the submission transaction; token rotation/revocation must write that same document.
- Ingestion and posting workers use separate write-bearing leases/fencing tokens; no read-only lease check can authorize financial posting.
- On move, retain the same Tenant-level link. Close/open only the selected Tenancy; other active units and the Tenant link remain unchanged.
- Closed-Tenancy obligations are resolved through the Tenant-level link, but allocations target only already-existing charges of the exact old Tenancy. Do not invoke the bank date-based tenancy rule or create new charges for a closed Tenancy.
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

G5.2 keeps the existing Celcom queue/provider, but extends it with session-aware protected enqueue, a versioned encrypted payload, API/history redaction, dispatch lease fencing and conservative crash recovery. Tenant/Tenancy/link/outbox/critical audit commit together when trusted G5 provisioning is REQUIRED; DISABLED creates no new link/outbox but still transitions any old link when its Tenancy closes/transfers. `moved_out` must become atomic; move must accept a caller-owned session; demo SMS must be explicitly suppressed. Move/move-out requests require exact `expectedTenancyId` values selected from the authenticated Tenant DTO's `activeTenancies[]`. B01/B03 merchant readiness, B05 inbound evidence retention, D17 protected outbox retention, B08 unknown-send recovery and D14 delivery SLA remain unresolved. D18 also requires an API contract change to expose and return exact expected Tenancy IDs.

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


## Tenant-level combined M-PESA account rules (12 November 2026)

- One Tenant profile, one Tenant-level private link, one-unit simple account, multi-unit combined statement within the same Estate.
- One verified M-PESA receipt is claimed once. G3 posts the portions to exact Tenancies and preserves any surplus as a Tenant-level carried-forward credit.
- Excess credit reduces future combined rent due for that same Tenant/Estate. Current G3 needs an auditable aggregate-credit extension; G5 does not own another wallet or ledger.
- G3's effective RENT-line due day determines the first rent cycle for a tenancy. A move-in after that date starts the next cycle at the full monthly amount; no proration. G5 consumes G3 RentCharges without recalculating rent.
- Existing SMS provider and sender configuration are unchanged.


> G5 collection addendum: see G5_COLLECTION_IMPLEMENTATION_DESIGN.md. Posting stays disabled (`G5_MPESA_POSTING_ENABLED`) and gated on B01/B02; gates B01–B05, B07–B10 remain unresolved.


### Daraja contract update (14 November 2026)

- C2B v2 registration succeeded in the Daraja sandbox for invocation-form shortcode `600987`; the separate app credential card showed `174379` and the identity relationship remains unproven.
- C2B v2 is now the default registration/simulation path. Pull Register response parsing uses `ResponseStatus`; Pull Query remains POST and supports the documented nested `Response` rows, lower-case field names and ISO-8601 timestamps.
- The documented Pull sample is `c2b-pay-bill-debit` (PayBill), so it is quarantined from the Buy Goods-only G5 flow. No Buy Goods Pull row has yet been captured.
- Pull registration has not been attempted; the supplied portal documentation describes a live shortcode prerequisite. Pagination completion and 48-hour eligibility still need provider evidence.
- Render OAuth succeeded from the deployed runtime. The callback feature gate remains disabled because callback authentication/abuse controls are not yet established. G5 posting remains disabled.

 
## Owner decision — authorized viewing of retained M-PESA SMS evidence (25 November 2026)

The product owner approves on-demand viewing of the original submitted SMS by authorized reviewers. This resolves the **authorized-visibility** part of G5-B05; it does not resolve the separate retention-period, dispute-hold, or deletion-schedule decisions.

- Authorized roles are `CLIENT_OWNER` and `CLIENT_ADMIN` within the authenticated client and estate scope. `SUPER_ADMIN` may read only after selecting one explicit client through the existing `clientContext` boundary. Existing server authorization and `estateFilter` remain authoritative.
- The original SMS remains encrypted in `MpesaSmsSubmission.evidenceEnvelope`. A dedicated authenticated detail read decrypts it in memory for that request only. Do not add plaintext to the submission list DTO, general history, tenant DTOs, or audit metadata.
- Every successful evidence read is audited as `G5_SUBMISSION_EVIDENCE_VIEWED` with the submission ID, client, estate and actor. The audit record must never contain the message or envelope. If the required audit write fails, do not return plaintext.
- The endpoint is read-only, returns `Cache-Control: no-store`, and returns no envelope, key ID, digest or encryption material. A missing retained envelope is reported as unavailable; a digest cannot reconstruct the original message.
- The frontend may hold the returned text only while the reviewer has the evidence view open. It must not persist it to IndexedDB, local/session storage, offline snapshots, analytics, logs or error telemetry.
- Viewing evidence grants no approval, force-match, association override, or posting capability. Existing two-evidence and G3 posting gates remain unchanged.

G5-B05 remains partially open until the owner separately approves the retention duration, dispute hold and deletion policy. This decision authorizes visibility only for evidence that is already retained under the configured policy.
