# G5 Daraja Callback Security and Receipt Replay — Implementation Handoff

**Status:** Owner-requested bounded implementation task  
**Repository:** `jolla3/tycoon-estates-backend`  
**Target branch:** `fix/g5-daraja-pull-contract`  
**Documentation baseline:** `main@d322374abac0cd35ce205e916de70c453af0eeda`  
**Target branch tip before this handoff commit:** `48d8512c48ed3a84080ec64439e70a04d503a239`  
**Scope:** Callback exposure safety, durable inbox replay/idempotency, canonical-receipt fail-closed behaviour, focused tests and documentation.  
**Explicitly out of scope:** Provider requests, callback simulation, Pull registration/query, live migrations, Render/environment changes, merchant activation, and G3 financial posting.

The target branch already exists. Its tree matches the current `main` tree; `main` is one merge commit ahead of the branch, with no file differences. Continue on the named branch. Do not create a differently named branch, force-move a ref, or write to `main`.

---

## 1. Objective

Close two safety defects in the G5.3 Daraja ingestion boundary:

1. A configuration toggle must not expose unauthenticated public Daraja callback routes when the provider authentication contract is still unknown.
2. Repeated or conflicting delivery of the same receipt must not create multiple durable processing events or multiple canonical transaction records. Until the canonical merchant/receipt uniqueness scope is proven and its exact unique index is ready, no canonical transaction write or financial posting may occur.

The implementation must preserve the existing C2B v2 and TransactionPull contract corrections already merged. This is not permission to redo the Pull adapter or widen G5 scope.

## 2. Non-negotiable release state

Keep all of the following disabled or false throughout the task:

- Public C2B confirmation callback exposure.
- Public C2B validation callback exposure.
- Public Pull result callback exposure.
- `G5_MPESA_POSTING_ENABLED` and every other MPESA financial posting gate.
- `canonicalReceiptIdentity` readiness while B01/B02 remain unresolved.
- Any merchant operational/registration state that is currently false.

Do not change Render environment variables, deploy, register callback URLs, simulate a transaction, register/query Pull Transactions, execute a migration against Atlas, or create a G3 Payment/Ledger entry.

A successful test must demonstrate that these gates remain closed. A passing unit test is not proof of Safaricom authentication, merchant identity, or production readiness.

## 3. Source-of-truth documents to read first

Read the current versions on this branch before editing:

- `docs/g5/PRD.md`
- `docs/g5/architecture.md`
- `docs/g5/architecture-summary.md`
- `docs/g5/G5_IMPLEMENTATION_GUARDRAILS.md`
- `docs/provider-contracts/G5_DARAJA_C2B_PULL_EVIDENCE.md`
- Relevant G5 schema/index and collection-ingestion design records linked from those documents.

Then inspect the current implementation and tests, especially:

- `src/routes/darajaWebhook.routes.js`
- `src/services/mpesa/darajaC2b.service.js`
- `src/services/mpesa/darajaPull.service.js`
- `src/services/mpesa/mpesaIngestion.service.js`
- `src/services/mpesa/mpesaNormalize.js`
- `src/models/MpesaIngestionEvent.js`
- `src/models/MpesaTransaction.js`
- `src/utils/mpesaIndexReadiness.js`
- `src/utils/ensureIndexes.js`
- `src/middlewares/rateLimiter.js` and request/logger redaction code
- Existing G5 migrations and focused unit/integration tests.

Fetch the live branch HEAD and inspect the diff before changing anything. Preserve unrelated work. Do not infer current state from a stale architecture snapshot.

### Mandatory review-before-code sequence

Before changing application code:

1. Write a concise evidence matrix separating source-verified facts, owner-supplied provider facts, proposed engineering controls, and unresolved blockers.
2. Critique the proposed approach: concurrency, replay ordering, lease races, MongoDB unique-index preflight, malformed payloads, C2B/Pull overlap, Redis failure, information leakage, and operational failure modes.
3. Update `PRD.md`, `architecture.md`, and `architecture-summary.md` together. Update `G5_IMPLEMENTATION_GUARDRAILS.md` and the provider evidence record where the implementation boundary or evidence classification needs to be recorded.
4. Make the three core documents agree. Keep the summary short and operational. Do not promote an assumption to a provider fact.
5. Only then implement this bounded slice and its tests.

Record rejected approaches and why they were rejected. Do not turn this handoff into a broad G5 rewrite.

## 4. Callback security: fail closed until provider authentication is proven

### Verified facts and blocker

The owner-supplied Daraja portal excerpt documents C2B v2 registration fields and callback transaction fields. It does **not** establish an inbound callback signature, authentication header, HTTP Basic authentication, fixed source IP ranges, mutual TLS, or callback retry/acknowledgement semantics. Validation is described as optional and requiring Safaricom enablement; enablement for this merchant is not established.

Outbound OAuth authenticates Tycoon when Tycoon calls Daraja. It does not authenticate a request arriving at Tycoon.

### Required behaviour

- Environment flags alone must never make these routes publicly reachable:
  - `/daraja/c2b/confirm`
  - `/daraja/c2b/validate`
  - `/daraja/pull/results`
- In particular, setting `DARAJA_CALLBACKS_ENABLED=1` must not bypass the missing provider-authentication prerequisite. The lab flag must not create an externally reachable unauthenticated bypass either.
- Keep the production routes unexposed and return the existing explicit “not exposed” response while authentication remains unresolved.
- Do not call the C2B confirmation, validation, or Pull ingestion handlers when the route is not exposed.
- The current validation handler unconditionally returns an accepted result. It must remain unreachable while validation semantics, merchant enablement, and callback security are unresolved. Do not invent new validation acceptance/rejection semantics.
- A future callback enablement requires a provider-specific verifier implemented from authenticated provider evidence, with its own tests and review. A bare `DARAJA_CALLBACK_AUTH_VERIFIED=1`-style environment switch is not proof and must not be used as a substitute for a verifier.
- Do **not** invent HMAC/signature headers, bearer or Basic headers, callback URL path/query secrets, Safaricom IP allowlists, mTLS, or OAuth-token reuse. In particular, do not add a path token that can leak through provider configuration, proxies, or request logs.
- Do not change the shared webhook limiter in a way that weakens bank webhook behaviour. If a Daraja-specific limiter is prepared for a future verified ingress, it must fail closed on Redis/store errors and must not be treated as authentication.
- Redact sensitive request material from application logs. Do not log full callback bodies, payer data, credentials, or any future secret-bearing values.

### Required tests

Add route-level tests proving, for each of the three endpoints:

- With production mode and callback enable flag set, the route still returns “not exposed” while no verified provider authenticator exists.
- The lab flag cannot expose the route in production.
- The business handler is not invoked and no ingestion record is created.
- The default configuration remains closed.
- A regression test covers the unconditional validation handler being unreachable through the public route.

Test the actual route middleware order. Do not only test a boolean helper detached from the mounted Express router.

**Release blocker remains:** the owner/provider must supply authenticated Daraja callback-authentication and acknowledgement/retry evidence before any public callback endpoint can be enabled.

## 5. Receipt replay and durable inbox idempotency

### Distinguish the two identities

There are two separate identities. Do not collapse them:

1. **Source observation identity:** deduplicates repeated delivery of one C2B callback observation or one Pull observation.
2. **Canonical provider receipt identity:** identifies one physical receipt across C2B and Pull, regardless of which source delivered it.

The source channel may distinguish inbox observations. It must **not** become part of the canonical receipt identity.

### Inbox requirements

Implement a deterministic, persisted idempotency key for every new `MpesaIngestionEvent`.

- For a well-formed event, derive the key from stable source-observation identity using the provider, normalized source channel, merchant shortcode as received/resolved for that observation, and provider receipt number. Hash the canonical encoding; do not store raw identity material in the key.
- Keep the payload digest as an integrity/comparison value. Do not use the payload digest as the primary identity for a valid receipt: an attacker or malformed retry must not obtain a new event identity merely by changing the amount, timestamp, or other payload field.
- For malformed events that do not have a usable receipt identity, use a deterministic bounded fallback that can deduplicate an exact repeated malformed payload. Such an event remains quarantine-only and can never become canonical by that fallback.
- Add a MongoDB unique index for the inbox idempotency key using the repository's guarded migration conventions. Preflight existing records first. If historical collisions exist, report them and stop. Do not delete, merge, rewrite, or silently choose a winner for existing events.
- The migration must default to dry-run and be allowlisted for explicit execution. Do not execute it in this task or against the live `estate` database.
- Runtime readiness must distinguish “inbox collection is operational” from “inbox idempotency uniqueness is installed and verified.” Do not claim the latter based on a Mongoose schema declaration alone.

### Duplicate handling

Make persistence race-safe:

- A repeated event with the same idempotency key and same payload digest returns the already-persisted event as a duplicate. It must not insert a second event or create a second processing attempt.
- A repeated event with the same key but a different payload digest is a conflicting replay. Quarantine the existing receipt/event identity, record bounded digest-only conflict evidence and timestamps/counters, and do not overwrite the original normalized values with the conflicting payload.
- Handle concurrent insert races through the unique index/E11000 path, then re-read and compare the durable record. Do not swallow unrelated database errors or treat a failed lookup as a successful duplicate.
- Respect the existing processing lease/fencing model. A replay must not start a second worker while the original event is actively owned.
- Do not store additional raw callback bodies or unbounded arrays of conflicting payloads. Follow existing redaction and retention decisions; do not invent a TTL.

A conflict must never proceed to canonical upsert or posting.

## 6. Canonical receipt identity: do not guess the merchant key

The PRD and architecture require the canonical receipt identity to be provider-scoped and based on the verified merchant profile plus provider receipt number. B01/B02 remain open because the exact Till/Store/Head Office relationship and merchant ownership scope have not been proven. The provisional shortcode-plus-receipt index is not an approved substitute.

Required behaviour while `canonicalReceiptIdentity === false`:

- Persist the source observation to the durable inbox if its inbox idempotency barrier is ready.
- Quarantine/defer canonical processing with an explicit reason such as `canonical_identity_unverified`.
- Do not call `MpesaTransaction` create/upsert/update paths.
- Do not create a claim, Payment, PaymentAllocation, Ledger movement, or posting state.
- Do not advance any future Pull checkpoint past observations that have not been durably ingested/quarantined under the verified provider contract.

The canonical readiness gate must be tied to the exact approved unique index being present in MongoDB and to the reviewed merchant identity scope. It must not be opened by a configuration boolean or by the presence of a Mongoose `unique: true` declaration.

Do not install or activate a canonical receipt index in this task. Do not choose a shortcode-only key or a source-channel-scoped canonical key.

### C2B/Pull convergence

- A repeated C2B callback is one source observation and must deduplicate at the inbox.
- A repeated Pull row is one source observation and must deduplicate at the inbox.
- The same physical receipt arriving once through C2B and once through Pull may produce two source observations, but both must converge to the same canonical receipt identity after merchant profile resolution and after B01/B02 plus the exact canonical unique index are approved and ready.
- While that canonical gate is false, both source observations remain durable/quarantined and neither is allowed to create a canonical transaction. Do not pretend the source-specific inbox key proves cross-source receipt uniqueness.

## 7. Required test matrix

Add focused tests for at least the following cases:

| Area | Case | Required assertion |
|---|---|---|
| Callback exposure | Production + `DARAJA_CALLBACKS_ENABLED=1` | All three routes remain unexposed |
| Callback exposure | Production + lab flag | No unauthenticated exposure |
| Callback dispatch | Route blocked | Confirmation, validation and Pull handlers are never called |
| Default posture | Flags absent | Callback routes remain closed |
| Inbox identity | Same source, shortcode and receipt repeated | One durable event; duplicate result points to existing event |
| Inbox integrity | Same source identity, different amount/time/payload digest | Existing receipt quarantined; original normalized data is not overwritten |
| Concurrency | Two simultaneous identical deliveries | One inbox row and one winning processing lease |
| Concurrency | Two simultaneous conflicting deliveries | One identity, conflict recorded, no canonical write |
| Cross-source | Same receipt observed by C2B and Pull | Distinct source observations are allowed; source channel is not used as canonical identity |
| Canonical gate | Canonical identity readiness false | No `MpesaTransaction` write for either source; event is durable and quarantined |
| Error handling | Unique-index race followed by lookup failure | Error is propagated/retryable, never acknowledged as a successful duplicate |
| Migration | Existing duplicate inbox keys | Dry-run reports collision and refuses execution; no automatic cleanup |
| Regression | Existing C2B v2 and Pull contract fixtures | Existing normalization, response-envelope, shortcode-context and PayBill quarantine tests remain green |
| Financial gate | Posting disabled / identity unresolved | No Payment, allocation or Ledger writes |

Use deterministic clocks and stable fixtures where timing is involved. Assert database state and call counts, not just returned status values.

Database integration tests may use only a dedicated disposable `tycoon_test_*` replica-set database with the repository's explicit destructive-test opt-in. Never point destructive tests at Render, Atlas production, or the live `estate` database. If no safe test database is available, run the focused unit tests and explicitly report the integration tests as not run.

## 8. Migration and operational constraints

- Follow `scripts/migrations/lib/g5MigrationGuard.js` and the existing allowlist/dry-run style.
- Preflight duplicate inbox keys, malformed legacy rows, collection existence, and exact database name before any index operation.
- Do not use `syncIndexes()`, automatic index creation, a broad collection rebuild, or any destructive cleanup.
- Do not run the new migration in this task.
- Do not run any migration against the live Atlas database.
- Do not change Render secrets, flags, deployment configuration, or the running service.
- Do not execute provider API calls, callback simulations, Pull registration/query, or live financial operations.

## 9. Regression and completion checks

Run the focused G5 unit suites first, then the full non-destructive test suite and lint. Keep the exact commands and output in the completion report. At minimum, preserve:

- Existing C2B v2 request/normalization contracts.
- Existing Pull registration/query response parsing and request-contract tests.
- PayBill exclusion and unknown Pull-type quarantine.
- Merchant profile ambiguity checks.
- Existing lease fencing and migration guard tests.
- Existing G3 BANK/MANUAL and G4 regression suites.

Before reporting completion:

1. Re-read the branch HEAD and review the complete diff.
2. Confirm no file or commit was written to `main`.
3. Confirm callback exposure gates are still closed.
4. Confirm `canonicalReceiptIdentity` and MPESA posting remain disabled.
5. Confirm no provider call, migration execution, Render mutation, or financial write occurred.
6. List every test that passed, failed, or was not run. Never label an unrun integration test as passed.

Do not open a PR or merge unless the owner explicitly asks.

## 10. Stop conditions

Stop implementation and report the blocker rather than guessing if:

- A proposed callback authentication mechanism is not supported by authenticated Daraja evidence.
- Existing inbox records collide under the proposed deterministic key and safe reconciliation is not already approved.
- Merchant identity scope requires choosing between shortcode, Store, Till, Head Office, or another provider field without B01/B02 evidence.
- The canonical unique index cannot be tied to the approved merchant profile identity.
- A test would require the live Atlas/Render environment or a provider operation.
- The change would require altering G3 financial posting or tenancy accounting beyond the stated fail-closed guard.

**Done means:** duplicate source observations are idempotent and conflicting replays are quarantined; unverified canonical receipt identity cannot create canonical transaction writes; all public callback routes remain unexposed; financial posting remains disabled; documentation, source, tests and evidence agree. It does not mean Daraja callbacks are ready for production.
