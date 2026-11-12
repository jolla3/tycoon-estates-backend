# G5 — Implementation Guardrails for Engineering Agents

**Purpose:** prevent an AI or human implementation agent from inventing missing product, repository, financial, security, or Daraja behaviour.  
**Applies to:** Grok, Codex, ChatGPT, developers, reviewers, and any delegated agent working on G5.  
**Current phase:** G5.2 post-independent-review documentation resolution. No implementation is authorized by this file.

---

## 1. Authority and evidence rules

Use the correct authority for each question:

| Question | Authority | Do not do this |
|---|---|---|
| Intended product behaviour | `PRD.md` and explicit owner-approved decisions | Do not redesign the product from convenience or assume an unstated feature. |
| What the current application actually does | Current repository source at the fetched HEAD, with exact file/line/commit evidence | Do not treat an earlier chat summary or stale audit snapshot as current source. |
| Existing architecture and integration boundaries | `architecture.md` reconciled against current source | Do not assume a model/service behaves as its name suggests. Trace callers and tests. |
| Safaricom API contract | Authenticated Daraja portal for the relevant app/product plus controlled sandbox request/response evidence | Do not infer exact methods, payloads, signatures, callback success rules, pagination, or enablement from a mirror or SDK alone. |
| Merchant-specific capability | The client's actual Safaricom/Till/Store configuration and controlled transactions | Do not claim that a generic API page proves this Till is enabled. |
| Financial invariants | G3 models, services, indexes, migrations, transaction behaviour and real Mongo integration tests | Do not implement a second ledger or invent credit semantics. |
| Security and privacy | Current application security primitives plus explicit data-owner policy | Do not store secrets/raw financial SMS in plaintext or invent retention periods. |

Every material claim in the review must be labelled as one of:

- **VERIFIED-SOURCE:** directly confirmed in current repository code/tests/migrations, with file and line/commit evidence.
- **VERIFIED-PROVIDER:** directly confirmed in official authenticated provider documentation or a controlled sandbox exchange, with date and artifact/fixture reference.
- **OWNER-DECISION:** product or policy choice explicitly approved by the owner.
- **PROPOSED:** a recommended design that has not been approved or proven.
- **BLOCKED/UNKNOWN:** evidence is missing or contradictory. No implementation may depend on it until resolved.

Do not describe `PROPOSED` or `BLOCKED/UNKNOWN` as implemented, tested, supported, enabled, or production-ready.

## 2. Phase lock: review before code

The current task is to review the G5 design and make the documentation internally consistent. It does not authorize:

- application source edits;
- model/schema creation;
- routes, middleware, workers, cron jobs or scheduler changes;
- index or database migrations;
- environment/secret changes;
- Daraja registration or production/sandbox account changes;
- SMS sends or financial transactions;
- deployments or production data changes.

The first deliverable is a written architectural critique and a synchronized set of G5 documents. Only an explicit owner instruction after the review authorizes implementation.

## 3. Repository preservation and source freshness

The drafting audit used `jolla3/tycoon-estates-backend` `main` at `204c8f9c3578f753af20727799aaa049b1545135`. This is a historical source snapshot, not a perpetual assertion about the branch.

Before implementation:

1. Fetch the latest repository state and record the exact `main` HEAD and intended working branch.
2. Inspect `git status`, branch, staged files, unstaged changes, untracked files and recent commits before touching anything.
3. Re-read all relevant current files at the new HEAD. Re-run narrow source searches for all callers of any service being changed.
4. Reconcile source drift against this design and update the audit/docs before code.
5. Preserve every unrelated user change.

Never run `git reset --hard`, `git clean`, force-push, broad restore/checkout, wholesale merge, or destructive rebase as a shortcut. Never overwrite another branch or user work to make a checkout match this audit. If the source cannot be fetched or reconciled safely, stop source-sensitive work and report the exact mismatch.

## 4. Product boundary: no scope drift

- Build Buy Goods / Till receipt attribution only.
- Do not redesign PayBill. Its account/reference field is not the problem.
- Do not add STK Push, outbound Buy Goods, B2C, withdrawals, refunds, or merchant settlement to the initial G5 scope.
- Do not use G4 `BankTransaction`, `BankAccount`, `BankConnection`, or bank reconciliation as the M-PESA domain.
- Do not create a new tenant dashboard or require full tenant registration unless separately approved.
- Do not introduce a generic event bus, Kafka, BullMQ, a second SMS delivery system, or an LLM parser without measured need and explicit approval.
- Do not alter G4's date-based `tenancyContains()` rule to support G5 late arrears.

## 5. Financial invariants that code must enforce

1. **Historical identity:** every link, SMS submission, winning transaction claim and posted Payment resolves to one exact `Tenancy._id` plus immutable `clientId`, `estateId`, `houseId`, and `tenantId` scope. The winning claim is transaction fields, not a separate initial claim collection.
2. **Third-party payer:** payer name/phone are evidence attributes, not the tenancy lookup key. Do not require payer phone = tenant phone.
3. **No fuzzy assignment:** no amount-only, phone-only, current-house, current-tenant, date-only, or nearest-match fallback.
4. **Canonical receipt:** callback and Pull converge to one canonical transaction, uniquely scoped by verified merchant identity and external receipt number. Until B01/B02 prove the scope and the exact unique index is installed and readiness-verified, candidates are non-postable.
5. **One receipt, one claim/payment:** concurrency must be enforced by the external receipt unique index, the Payment-to-internal-transaction unique index, and conditional state transitions, not only Redis locks. The Payment index alone does not prevent duplicate transaction documents for one external receipt.
6. **G3 remains authority:** `Payment.origin = 'MPESA'`; `Payment.mpesaReceiptId` points to the internal `MpesaTransaction._id`; do not put the external alphanumeric receipt in an ObjectId field.
7. **Atomic commit:** Payment, PaymentAllocation rows, RentCharge projections, Ledger PAYMENT, and claim/transaction POSTED state commit or roll back in the same Mongo transaction.
8. **Exact allocation scope:** no allocation crosses the link-bound tenancy or client/estate/house scope.
9. **Late arrears:** closed tenancy path can touch only pre-existing eligible charges on that exact old Tenancy; no charge generation; no credit transfer to the new Tenancy.
10. **Overpayment:** full receipt value must be accounted for. Prove how G3 represents unapplied credit; if it cannot do so safely, do not auto-post the overpayment. Route it to controlled review. Never silently drop the residual amount.
11. **Historical coverage:** no `SETTLED` link state from a zero projection alone. Require verified historical coverage, no unresolved obligation/credit, and no open claim.
12. **Compatibility:** preserve BANK and MANUAL posting semantics and all G4 workflows. A shared-service change must prove that these callers behave as before.

## 6. Link token and SMS security rules

- Generate at least 32 cryptographically random bytes from the platform CSPRNG.
- Store only a one-way hash or keyed digest in the link record. Enforce uniqueness and constant-time comparison where applicable.
- Link association is permanent to the historical Tenancy; its bearer secret is not immutable. Provide revocation/rotation after loss or compromise without reassigning the tenancy.
- Prefer a URL fragment that is never sent in the initial HTTP request, then immediately remove it from browser history and submit the credential in a POST body. Do not place it in query/path values that are commonly logged. If the implementation uses another pattern, prove every proxy, access log, analytics, trace, referrer and error path is redacted.
- Do not use localStorage/sessionStorage for the permanent bearer token. Keep it in memory only while the form is active.
- Public link pages must not contain third-party analytics/pixels. Apply `Cache-Control: no-store`, `Referrer-Policy: no-referrer`, restrictive CSP, request-size limits and rate limits.
- Never reveal tenant PII, arrears, house identity, merchant configuration, or whether a link exists before valid token possession.
- Existing `SmsMessage.message` is plaintext in the audited snapshot. Do not insert a token-bearing URL there.
- Protect the temporary SMS body with authenticated encryption at rest, a versioned key identifier, authenticated associated data bound to the message/client/type, and least-privilege decryption at send time. Never log plaintext, ciphertext envelope, encryption keys, or bearer token.
- Redact protected payloads from JSON serialization, tenant details, SMS history, admin lists, audit records, error reports and provider logs.
- External SMS provider calls happen only after the Mongo transaction commits.
- For provider delivery `unknown`, do not blindly retry. Resolve through a verified provider status API or explicit operator process before resend. Do not invent a status query endpoint.
- Agree raw SMS and payer PII retention, dispute holds, authorized access and deletion behaviour before production. Encryption does not make indefinite retention automatically acceptable.

## 7. Daraja: no provider-contract invention

Do not invent or infer any of the following:

- C2B callback registration endpoint, method, request fields or response fields;
- Pull registration endpoint, method, request fields, query method, query window, pagination or checkpoint semantics;
- callback authentication (HMAC, Basic auth, shared secret, mTLS, IP allowlist or any other mechanism);
- callback acknowledgment body/status and Safaricom retry policy;
- shortcode/Till/Store/Head Office/Notification/Nominated Number relationships;
- whether the actual Buy Goods Till is eligible for both callback and Pull Transactions;
- whether one app credential set is global to Tycoon or scoped per merchant;
- transaction status/direction/reversal semantics;
- timestamp timezone, formatting, precision or matching tolerance.

For each item, produce an evidence artifact from the authenticated portal and a controlled sandbox exchange. Keep exact provider field names and casing inside the Daraja adapter. Normalize only after schema validation. Preserve sanitized source fixtures with secrets and PII removed. Unknown or malformed records are durably quarantined; they are never guessed into a tenant payment.

The publicly mirrored Pull Transactions page may be used to discover questions and candidate API behaviour only. It is not proof of the actual merchant's capability or current contract. The often-mentioned 48-hour horizon must be confirmed in the authenticated portal and sandbox before coding recovery assumptions.

## 8. G3 integration: source tracing required

Before changing `accountingPosting.service.js`, inspect and document:

- every caller of `postConfirmedPayment()` and all its validation/defaulting branches;
- Payment schema fields, indexes, refs, enum, and serialization;
- `PaymentAllocation` uniqueness and charge allocation invariants;
- `RentCharge` balance/status projections and charge-generation paths;
- Ledger entry source/reference constraints and transaction requirements;
- how unapplied/overpaid amounts are represented and recovered;
- `Tenancy.ledgerRev` and allocation lock/optimistic concurrency semantics;
- index readiness and migration ownership;
- existing BANK and MANUAL unit/integration/concurrency tests.

Then design the MPESA branch as a narrow extension. It must validate exact canonical transaction scope and verify an existing Payment on idempotent retry. Preserve current BANK/MANUAL behaviour. Do not bypass the service and write Ledger directly.

`Payment.mpesaReceiptId` is already an ObjectId field in the audited snapshot. Confirm the current live index name, key, uniqueness and partial filter at the database before implementation. Do not assume a schema declaration proves a production index exists. Do not drop or rebuild indexes at startup.

## 9. Closed-tenancy policy and gating

The policy is link-bound, not date-bound:

- A payment submitted through an old tenancy link remains intended for that old tenancy even if paid after move-out.
- Only already-existing eligible charges of that exact Tenancy can be allocated.
- No new charge generation for a closed tenancy.
- No current-house/current-tenant lookup and no G4 date-based matching.
- Any unapplied amount remains credit of that exact old tenancy; it cannot be used by a later occupancy.
- If G3 cannot represent that residual safely, the receipt is review-only until a supported accounting path is approved.
- A closed link is not terminal while legacy balance coverage is `UNVERIFIED`, or any eligible charge, unapplied credit, or pending/conflicting claim remains.

The current source audit indicates `ledgerService.postEntry()` does not require the Tenancy to be ACTIVE, and supplied charges in G3 posting are checked against exact tenancy scope. This is not enough to conclude that the entire post-closure and overpayment path is production-safe. Test the actual service and ledger contracts with a real Mongo transaction before claiming support.

## 10. Tenant lifecycle requirements

Trace every code path that creates, moves, closes, voids, or changes the status of a tenancy. Do not integrate only `tenantService.create()`.

At minimum inspect:

- tenant creation and tenancy open;
- `tenancyService.moveToHouse()` and all entry points calling it;
- `tenantService.update(status='moved_out')` and current non-atomic behavior;
- direct tenancy close/void paths and administrative correction flows;
- any scheduled process that changes tenant/house occupancy pointers.

Lifecycle transitions affecting Tenant, Tenancy, MpesaSubmissionLink and protected SMS outbox must share a clear transaction boundary. Old links remain bound to old Tenancy. New occupancy receives a new link. A failed outbox/link write rolls back the associated lifecycle mutation or leaves a durable recoverable outbox state with a documented invariant; it must never leave a half-created link silently.

## 11. Index, migration, and worker rules

- Design unique identities before implementation. Candidate uniqueness: link token digest; one link per Tenancy; merchant identity within verified scope; `(merchantProfileId, receiptNumber)`; one Payment per internal canonical transaction. The winning claim is a conditional state transition on `MpesaTransaction`, not a separate unique claim collection.
- MPESA financial posting must fail closed until the exact external receipt unique index is proven, installed, and runtime-verified; do not treat `Payment.mpesaReceiptId` as a cross-document external receipt constraint.
- Treat candidate key patterns as provisional until the actual Till/Store hierarchy and current schemas are verified.
- Guard every unique-index migration with duplicate preflight, exact index inspection, explicit migration execution and readiness verification.
- Do not place destructive financial index mutation in ordinary application startup.
- Use Mongo conditional updates/claim tokens with lease expiry and fencing. Link submission/rotation must write-fence the same `MpesaSubmissionLink`; ingestion workers must have reclaimable inbox leases; posting must write-fence the same `MpesaTransaction` inside the G3 session. A read-only snapshot check is insufficient. A stale worker must be unable to post after a newer worker takes ownership.
- Redis is for scheduler coordination only. It cannot be the source of financial truth or the only duplicate barrier.
- Pull checkpoints advance only after every item in the page/window is durably ingested or quarantined.
- Do not advance a failed pull checkpoint to hide a gap. Monitor age relative to the confirmed provider retention horizon.
- Reuse existing scheduler/provider infrastructure; do not introduce another queue without measured justification.

## 12. Testing requirements and safety

### Unit tests

- Token generation/hash/revocation/rotation and leakage prevention, including a concurrent submission-vs-rotation CAS test.
- Deterministic SMS templates, parser versions, invalid/truncated messages, amount/time normalization, unsupported templates.
- Daraja adapter against actual sanitized callback/pull fixtures, including malformed/unknown fields and merchant variants.
- Verification matrix: exact match, wrong amount, wrong merchant, time outside approved tolerance, third party, duplicate, reversal/debit, missing provider record.
- Claim state machine, idempotency, lease expiry, stale-worker fencing and retry.
- Readiness behaviour when required unique indexes are absent or misaligned.

### Real Mongo integration/concurrency tests

- Tenant + Tenancy + link + encrypted outbox atomic create/rollback.
- Move creates distinct old/new links; old link never retargets.
- Close/move and claim/post serialize against the correct tenancy revision.
- moved_out path is transactional and requires the exact expected Tenancy ID.
- Stale move/move-out requests cannot mutate a later Tenancy or clear a different occupant's House pointer.
- Protected SMS payload never appears in API/history/serialization/logs.
- Callback and Pull overlap create one canonical transaction when the exact external identity index is ready; otherwise duplicate candidates remain non-postable.
- SMS-before-Daraja and Daraja-before-SMS both converge.
- One receipt submitted against two links never posts twice or switches tenancy.
- Duplicate internal transaction candidates for one external receipt cannot post while external receipt uniqueness is unavailable.
- Inbox worker lease expiry and reclaim cannot cause duplicate normalization.
- A submission racing token rotation/revocation serializes through a write-bearing link update; read-only token revalidation is rejected.
- Concurrent callback, pull, submission, and retries create one Payment and one Ledger movement.
- Crash/failure at every step between Payment insert, allocation insert, Ledger insert, and claim update produces all-or-nothing state.
- Stale claim worker cannot commit after lease takeover.
- Closed-tenancy payment allocates only existing old-tenancy charges; no new charge is generated.
- Overpayment is old-tenancy credit or blocked for review; new tenancy unchanged.
- `SETTLED` is blocked when historical coverage is unverified, credit unresolved, or claims remain.
- BANK and MANUAL regression behaviour unchanged.

### Test environment safeguards

Use only a dedicated disposable `tycoon_test_*` database, explicit `TYCOON_ALLOW_DESTRUCTIVE_TEST_DB=1`, and a verified MongoDB replica-set/sharded topology. The current helper's clear operation can delete every application collection. Never run destructive fixtures against production or a normal developer database. Keep test output in the terminal; do not leave JSON result files, persistent logs, or caches unless explicitly required.

## 13. Required self-critique before implementation

The agent must challenge its own plan in writing and answer every question with evidence or `BLOCKED/UNKNOWN`:

1. What assumptions did we quietly make about the merchant/Till hierarchy?
2. Can one receipt be duplicated across stores, apps or merchant profiles? What exact uniqueness scope does Safaricom guarantee?
3. What happens if callback is replayed after a claim is posted?
4. What happens if Pull returns an old record after a new tenant has occupied the house?
5. What happens if the link is rotated while an SMS submission or claim is in flight?
6. What happens if tenancy closure races claim creation or G3 posting?
7. What happens if the worker lease expires while the database transaction is running?
8. Can a second receipt be attached to the same SMS submission, or a second link to the same receipt? What is the intended relationship cardinality?
9. Can the G3 posting service safely represent a full overpayment and its unapplied credit for a closed Tenancy?
10. How do we prove historical balance coverage before link settlement?
11. Could any route, proxy, SMS history endpoint, audit event, trace, exception, provider SDK or browser referrer leak the bearer URL or raw SMS?
12. Can a Celcom `unknown` result cause duplicate or unintended sends?
13. Does the actual Daraja contract authenticate callbacks? What happens if it does not provide a cryptographic signature?
14. What if pull pagination partially succeeds, the worker crashes, or the provider data horizon expires?
15. Which proposed component is overengineering, and what existing source service should be reused instead?
16. Which G3/G4 tests prove compatibility, and which new real-database tests prove the new invariants?
17. What part of the design cannot be implemented safely with the current source contracts?

Do not dismiss a failure mode with “we use transactions” or “we use Redis.” State the exact unique constraint, conditional update, transaction boundary, lease/fencing check, rollback behaviour and test that prevent it.

## 14. Required handoff output from the review agent

Return:

1. Exact repository HEAD and working-tree status observed.
2. A source evidence matrix with paths, symbols, relevant code/test evidence and commit.
3. A provider evidence matrix with exact Daraja portal page/operation and sanitized sandbox request/response fixtures.
4. A list of product decisions that are already fixed versus blockers requiring owner approval.
5. The self-critique from Section 13.
6. A change list for all G5 docs, with each change tied to evidence or a labelled proposal.
7. A clear **GO / NO-GO for G5.1**, with reasons. A GO is not authorization to implement unless the owner separately authorizes it.

The review phase ends with documents and evidence only. No source code, migration, credentials, SMS sends, provider registration, or deployment.


## 15. G5.0.2 source-review additions and Git safety (12 November 2026)

### Public bearer submission route

The normal `/api/v1` router is behind `csrfProtection`; only signup/login are exempt. Do not add a broad CSRF bypass. A G5 bearer-token submission route must be separately mounted before the authenticated CSRF boundary, must not create or depend on a cookie session, and must not be mixed into the provider webhook namespace. Its strict, bounded JSON parser must run before the existing global JSON parser. The current Redis rate-limit store fails open on Redis errors, so specify fail-closed or independent upstream abuse controls for this public route.

### SMS dispatch recovery

The existing SMS queue is drained by `smsReminderJob` every 15 minutes from the API-process scheduler. It is not a dedicated worker process. The existing claim function selects `queued` records only; stale `processing` jobs are not reclaimed in the inspected queue path. Do not requeue an expired protected-link job blindly because Celcom may already have accepted it. Keep Celcom `unknown` in controlled resolution until an evidence-based status/retry policy exists. Extend the existing provider queue; do not create a second queue.

### G3 credit and historical coverage

G3 already exposes tenancy-scoped positive `knownCreditCents` and avoids netting credit between different tenancies in the house projection. Overpayment can appear as an `OVERPAID` charge or as an unapplied Payment remainder. This does not authorize refunds or cross-tenancy transfers. Current tenancy-balance helpers still return `historicalCoverage: 'UNVERIFIED'`; no link may be marked `SETTLED` from a zero projection.

### Tenancy lifecycle

The `moved_out` update currently writes Tenant and closes Tenancy separately. Refactor to one transaction before adding link/outbox state. `tenancyService.moveToHouse()` already uses a transaction for old/new occupancy changes; include link transitions and outbox there. The demo seed path opens Tenancies directly and must be explicitly no-send.

### Git branch protection evidence

The GitHub branch API reported `protected: false` for `main` during this review. The classic branch-protection detail endpoint returned 403 to the connected integration, and the visible repository rulesets query returned an empty list. Therefore repository protection is **not verified** by this session. Treat the no-touch rule for `main` as an absolute workflow policy, not as something GitHub is known to enforce. Before any push, re-read the live feature-branch HEAD and use a non-force fast-forward update with the expected prior SHA. All G5 changes remain documentation-only until a separate explicit implementation authorization.


## 16. G5.1 schema/index design boundary

Use `docs/g5/G5_1_SCHEMA_INDEX_DESIGN.md` as the core schema/index proposal and `docs/g5/G5_2_TENANCY_LINK_AND_OUTBOX_DESIGN.md` for lifecycle/outbox refinements. Treat `MpesaSubmissionLink.dispatchRevision` and all unapproved SMS envelope/lease fields as PROPOSED, not existing.

- Do not implement a separate PaymentClaim collection unless a concrete independent lifecycle requires it; the proposal places the winning claim and fenced posting state on the canonical MpesaTransaction.
- Do not finalize merchant identity or receipt uniqueness before B01/B02 evidence.
- Do not introduce a Pull checkpoint schema before the authenticated provider contract defines the resumable cursor/window/page unit.
- Do not choose credential ownership/storage before B09.
- Do not add TTL/retention indexes before B05.
- Public bearer submission should fail closed when the shared limiter is unavailable unless equivalent independent upstream protection is verified. This is the preferred technical default, not an owner-approved product rule.
- Design approval does not authorize application implementation. A separate explicit owner instruction must name the implementation slice.

## 17. G5.2 tenancy lifecycle and protected-outbox boundary

Use `docs/g5/G5_2_TENANCY_LINK_AND_OUTBOX_DESIGN.md` as the proposed design. It is not implementation authorization.

- Keep `tenantService.create()` Tenant/Tenancy creation and G5 link/outbox creation in one caller-owned Mongo session. Preallocate stable IDs, token/version and idempotency key; pin the outbox key version. Generate a fresh GCM nonce/envelope inside each retryable callback attempt after session-bound merchant validation. Never reuse a nonce/key pair across callback retries.
- Refactor `tenancyService.moveToHouse()` to accept a caller-owned session (or use one shared lifecycle orchestrator) so old Tenancy close, old-link `ARREARS_ONLY`, new Tenancy, new link/outbox, House/Tenant pointers and critical audit commit atomically. Expose `currentTenancyId` in authenticated tenant detail and require `expectedCurrentTenancyId`; compare source House pointer to the exact old Tenant and require a vacant/consistent destination House pointer before assigning. Same-house move remains a no-op.
- Refactor `tenantService.update(status='moved_out')` before G5 integration. Require `expectedTenancyId`, and do not write Tenant status outside the transaction that closes that exact Tenancy, conditionally updates House, transitions the old link and writes critical audit. Remove the fallback that unconditionally clears the House pointer when no matching active tenancy is found. Pass the authenticated actor ID through create/move/move-out service signatures and persist it on Tenancy/AuditLog. Require exact House pointer updates to match the expected tenant and `matchedCount === 1`; stale requests must conflict, never clear later occupants.
- G5 provisioning is a trusted server-side `DISABLED`/`REQUIRED` decision, never a tenant-controlled body field. REQUIRED fails the whole operation if exactly one permitted operational merchant cannot be resolved or protected encryption/outbox readiness is unavailable. DISABLED creates no new link/outbox but still transitions an existing old link when its Tenancy closes/transfers.
- Do not hook G5 provisioning to every low-level `tenancyService.open()` call. The seed script uses it directly. Demo/test flows must explicitly stay G5-disabled.
- `queueSms()` and `withIdempotency()` do not accept a Mongo session. Do not call them unchanged inside lifecycle transaction. Add session-aware protected enqueue using the existing SMS record/idempotency barrier; inspect the actual live `smsmessages.idempotencyKey` unique index before relying on it.
- G5 protected destination/body must be inside a dedicated versioned authenticated-encryption envelope with AAD bound to message/client/estate/tenant/house/link/tokenVersion/deliveryMode/dispatchMode/type/notificationVersion/idempotencyKey/formatVersion/keyId. Do not use plaintext fallback, the legacy unversioned encryption helper unchanged, or bank-only key material.
- Ordinary SmsMessage fields, JSON, history, tenant detail, audit, logs and errors must not expose bearer URL, plaintext body, ciphertext or key material. Decrypt only immediately before provider dispatch.
- Never call Celcom inside a `withTransaction()` callback. MongoDB may retry the callback; provider sends inside it can duplicate.
- Dispatch uses a Mongo lease token and expiry. `sendStartedAt` is the external side-effect boundary. The standard worker claim query must exclude `deliveryMode: G5_PROTECTED`; the protected branch claims/decrypts only G5_PROTECTED rows and never falls back to plaintext. Stale pre-send work may be reclaimed only after current link/version validation; post-send-start expiry/exception/no-response/5xx is `unknown`, never blindly queued. All completion/reclaim writes require the current lease token. A late response may settle `unknown` only if the original attempt token still matches; a new authorized attempt uses a new token.
- `sent` means provider accepted, not handset delivery. Celcom `unknown` remains unresolved until B08 gives verified provider lookup or controlled operator policy. The current Celcom adapter ignores the extra idempotency-key argument; do not assume provider-side deduplication. D14 must set maximum time-to-first-attempt; do not assume the current 15-minute cadence is acceptable. D17 must define protected outbox payload clearing/hold policy.
- Seed/test messages must be explicitly suppressed and excluded from the atomic dispatch claim query. The source currently inserts “not sent” SMS samples as `queued`; this is a verified risk, not a hypothetical cleanup.
- No TTL/retention duration or key rotation grace period may be invented. B05 governs inbound SMS/payer evidence; D17 governs encrypted outbound recipient/body retention; B08 governs unknown delivery recovery.

### Additional G5.2 tests required

- Transaction rollback at every step of Tenant/Tenancy/link/protected-outbox/audit create.
- G5 DISABLED path and REQUIRED fail-closed path for missing/ambiguous/non-operational merchant and missing key.
- Move old/new Tenancy/link/outbox atomicity; same-house no-op; moved_out failure rollback; repeat move-out cannot alter a later occupancy.
- Concurrent create/move/link uniqueness; rotation/revoke versus send-start CAS.
- Envelope tamper/AAD/key-version tests; tenant detail/history/JSON/log/audit redaction.
- Two worker claims cannot send the same row; expired pre-send lease safely reclaims; expired post-send-start lease becomes unknown; stale worker cannot overwrite after takeover.
- Demo seed messages use suppressed mode; worker does not claim them and provider mock receives zero calls.
- Existing standard SMS recipient idempotency, queueing, failure/unknown and concurrent claim tests remain green.

## 18. G5.2 design/implementation gate

Independent review must challenge the lifecycle state machine, provisioning policy, encryption/AAD/key rotation, lease expiry and seed suppression. After review, the owner must explicitly authorize a bounded implementation slice. Until then, no Tenant/Tenancy refactor, SmsMessage model change, key creation, worker/scheduler change, migration or provider send is permitted.

## 19. G5.2.1 independent review resolutions are mandatory

The independent verdict was **APPROVE WITH REQUIRED CHANGES**. The correction record in docs/g5/G5_2_TENANCY_LINK_AND_OUTBOX_DESIGN.md §16 supersedes any looser wording elsewhere.

- Never move or move out without the exact expected ACTIVE Tenancy ID. Never infer the target solely from Tenant.houseId.
- Never clear an old House pointer without _id + clientId + tenantId: expectedTenantId and matchedCount === 1. Never close a Tenancy if its exact House pointer compare matched zero.
- A destination House with any non-null tenantId is a conflict; do not automatically repair an orphan pointer, even when it equals the moving tenant.
- A replay is a no-op only when the exact expected Tenancy is already CLOSED with closeReason MOVE_OUT. It must never touch a later occupancy.
- For an active Tenant, currentTenancyId requires exactly one tenant-scoped ACTIVE Tenancy and matching Tenant/House ownership. Zero/multiple rows or pointer mismatch is a conflict.
- Pass actor identity into create/move/move-out lifecycle services and same-session audit writes.
- Extend strict SMS enums for g5_onboarding_link, cancelled and suppressed before inserting those values.
- Keep mutually exclusive claim branches: standard excludes G5_PROTECTED while preserving missing legacy fields; protected requires G5_PROTECTED and SEND. Protected messages never use plaintext fallback.
- Reclaim expired protected work only before send-start and after link/version validation. Post-send-start expiry is unknown, never automatic requeue. Every transition is fenced by the attempt token.
- submissionRevision, dispatchRevision, tokenVersion and notificationVersion are distinct. Send-start uses observed dispatchRevision CAS paired with SMS row update in one transaction.
- Verify the live smsmessages.idempotencyKey unique index and duplicate state. Mongoose unique:true is not live proof.
- Seed/test rows use status suppressed plus dispatchMode SUPPRESSED; provider mock must record zero calls.
- D11 records owner acceptance/support handling for an in-flight SMS arriving after token invalidation. D14 sets maximum dispatch latency; B08 controls unknown resolution; D17 controls encrypted outbound retention.
- B09 is Daraja API credential scope. No API credential or secret belongs in an SMS body.

No application code, models, migrations, keys, worker/scheduler changes or provider sends are authorized by this documentation correction.
