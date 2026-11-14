# G5 Daraja callback security and replay — progress checkpoints

## Checkpoint 1 — documentation (before code)
- Start HEAD: `2e690aa67c41b9dfe457c78e28175f3d01c89c7a` (`fix/g5-daraja-pull-contract`). Baseline: unit suite 60 suites / 386 tests passing.
- Done: architecture section 31 (evidence matrix, critique, rejected approaches), PRD section 24, summary note, guardrails section 24, provider evidence classification note.
- Files: docs/g5/{architecture,PRD,architecture-summary,G5_IMPLEMENTATION_GUARDRAILS}.md, docs/provider-contracts/G5_DARAJA_C2B_PULL_EVIDENCE.md.
- Next: close callback routes behind verifier seam + route tests.

## Checkpoint 2 — Objective A (callback security) implemented
- Added `src/services/mpesa/darajaCallbackAuth.js` (verifier seam; `getProviderCallbackVerifier()` returns null; gate returns 503 "Not exposed").
- `darajaWebhook.routes.js`: all three routes behind `darajaIngressGate`, ahead of the rate limiter and handlers. Flag-based exposure removed; `DARAJA_CALLBACKS_*` flags are inert.
- Tests: `tests/unit/mpesa/darajaCallbackRoutes.test.js` — 6/6 pass (real router; handlers and limiter call counts zero).
- Next: Objective B — inbox idempotency (model fields, key builder, persist algorithm, readiness spec, canonical fail-closed guard, migration, tests).

## Checkpoint 3 — Objective B (receipt replay / duplicate protection) implemented
Start HEAD for this checkpoint: 57733b7 (Checkpoint 2).

Files changed:
- `src/models/MpesaIngestionEvent.js` — added `idempotencyKey`, `replayCount`, `lastReplayAt`,
  `conflictCount`, `firstConflictAt`, `lastConflictAt`, `conflictDigests` (capped at 5).
- `src/utils/mpesaIndexReadiness.js` — `INBOX_IDEMPOTENCY_INDEX` (partial unique on
  `idempotencyKey`, filter `{ $type: 'string' }`); `indexMatches` now also compares
  `partialFilterExpression` exactly; new `gates.inboxIdempotency`; `isInboxIdempotencyReady()`
  and `isCanonicalReceiptIdentityReady()` (both fail-closed, read verified index inspection only,
  no env flag).
- `src/services/mpesa/mpesaIngestion.service.js` —
  - `buildInboxIdempotencyKey(normalized)`: `obs1:sha256([...])` keyed on
    provider+sourceChannel+businessShortCode+receiptNumber (NOT payloadDigest, NOT canonical
    identity); bounded `mal1:` fallback for un-keyable observations (quarantine-only).
  - `persistIngestionObservation()`: refuses (`inbox_idempotency_not_ready`) unless the index is
    verified; on E11000 re-reads by key — same digest ⇒ duplicate (`$inc replayCount`, no new
    row); different digest ⇒ conflict (quarantine, category `replay_conflict`, fence any active
    lease by clearing the lease token/expiry, `$inc conflictCount`, capped `conflictDigests`,
    original `payloadRedacted`/fields never overwritten); failed re-read ⇒
    `inbox_duplicate_lookup_failed` (retryable, never a false duplicate); inside an active Mongo
    transaction the duplicate-key error is re-thrown, never swallowed.
    `persistIngestionEvent` kept as a back-compat wrapper (event-only return).
  - `processClaimedEvent`/`upsertCanonicalTransaction`: fail-closed guard —
    `isCanonicalReceiptIdentityReady()` must be true or the event is completed
    `QUARANTINED/canonical_identity_unverified` with **no** `MpesaTransaction` create/upsert and
    no Payment/allocation/Ledger write; same check duplicated inside `upsertCanonicalTransaction`
    as defense in depth.
  - `ingestNormalizedObservation()` adapted to the new persist outcomes (no claim on
    duplicate/conflict).
- `src/services/mpesa/darajaC2b.service.js`, `darajaPull.service.js` — adapted to
  `persistIngestionObservation`; duplicate/conflict outcomes never call `claimIngestionEvent` or
  `processClaimedEvent`; persist errors are not acknowledged (C2B confirm returns 500/not-ack'd).
- `scripts/migrations/20261114_g5_inbox_idempotency_index.js` — dry-run default; preflight
  blocks (no cleanup) on existing duplicate keys or legacy same-receipt collisions; creates only
  `uniq_mpesa_inbox_idempotency`; touches no `MpesaTransaction`/canonical index.
- Tests added: `tests/unit/mpesa/inboxIdempotency.test.js` (14 tests — key derivation, refuse when
  not ready, identical repeat, conflicting replay + lease fencing + no overwrite, digest cap,
  concurrent identical/conflicting delivery races, E11000+lookup-failure, duplicate-in-transaction
  propagation, C2B-vs-Pull are two events, canonical fail-closed, partial-index spec matching),
  `tests/unit/mpesa/inboxMigrationAndCallers.test.js` (10 tests — migration declares only the one
  index with no drops, preflight read-only duplicate/legacy detection, clean-data no-blockers,
  `--execute` refused without allowlists, C2B caller never claims/processes on
  duplicate/conflict, persist failure not acknowledged, static import check that the ingestion
  path never imports Payment/allocation/Ledger/posting), and a guarded real-MongoDB integration
  suite `tests/integration/g5.inboxIdempotency.mongo.test.js` (skipped here — no
  `tycoon_test_*` replica set / `TYCOON_ALLOW_DESTRUCTIVE_TEST_DB=1`).

Environment note (not a code change, not committed): this run started in a fresh container with
no local `.env` (gitignored, never tracked). Recreated a local test-only `.env` with the same
non-secret placeholder values `tests/setup.js` already uses, so suites that construct their own
Express app (and therefore import `config/environment.js` without going through
`tests/setup.js`) can load. No real credential exists anywhere in this repo or this file.

Tests run:
- `NODE_OPTIONS=--experimental-vm-modules npx jest tests/unit/mpesa` → 10 suites, 72 passed.
- `NODE_OPTIONS=--experimental-vm-modules npx jest tests/unit` (full non-destructive unit suite)
  → **63 suites / 416 tests passed, 0 failed.**
- `NODE_OPTIONS=--experimental-vm-modules npx jest tests/integration/g5.inboxIdempotency.mongo.test.js`
  → 1 suite skipped (3 tests skipped) — correctly gated: no `MONGODB_URI`/
  `TYCOON_ALLOW_DESTRUCTIVE_TEST_DB=1` in this environment. Not run against any live/shared DB.
- `npm run lint` → cannot run: no `eslint.config.js` exists anywhere in this repository's git
  history (pre-existing, unrelated to this branch or this change). Not fixed here — out of the
  authorized scope (would be a project-wide tooling change, not part of this assignment).

Confirmed untouched: `main` branch; Render config/secrets; no Daraja provider call, simulated
callback, or Pull registration/query was made; callback exposure gate stays closed (`503 Not
exposed`, verified by Checkpoint 2's route tests, re-run above); `canonicalReceiptIdentity` gate
stays hard-coded unreachable without a verified index inspection (and is false in this
environment since no DB is connected); `G5_MPESA_POSTING_ENABLED` stays unset; no live migration
executed (`--execute` not passed; only imports + fake-db preflight tests run).

Remaining / next:
- Objective B is functionally complete pending real-sandbox/replica-set verification of the
  integration suite (owner must supply a disposable `tycoon_test_*` replica set).
- Unresolved provider/merchant blockers (unchanged from Checkpoint 1): B01/B02 canonical receipt
  identity scope, inbound callback authentication evidence, merchant uniqueness scope.
- Next action: final verification pass (re-read HEAD, full diff review), then produce the
  evidence-based completion report. No further implementation planned unless review surfaces a
  defect.

## Checkpoint 4 — correction pass: migration backfill, real-Mongo coverage, recovery lifecycle, strict readiness gate
Start HEAD for this checkpoint: `52750b1` (Checkpoint 3). Not yet committed/pushed — working tree only.

**A. Historical inbox idempotency migration** (`scripts/migrations/20261114_g5_inbox_idempotency_index.js`)
Rewritten from a plain index-creation migration into a read-then-backfill-then-verify-then-create
flow:
- `deriveLegacyKey(doc)` calls the exact production `buildInboxIdempotencyKey()` — no second
  algorithm. Returns null (never guesses) when `sourceChannel`/`payloadDigest` are missing.
- `classifyLegacyDocs(docs, existingKeys)` (pure, unit-tested without Mongo): every unkeyed
  record is either `eligible` (unique derived key, no collision with another legacy record or an
  existing key) or a `blocker` (`cannot_derive_identity`, `legacy_key_collision`,
  `collides_with_existing_key`). Two legacy rows that derive the same key block **both** — never
  merged or silently chosen.
- `runPreflight(db)` streams existing keys and unkeyed docs (projection-only cursors, capped by
  `G5_INBOX_MIGRATION_MAX_SCAN`, default 200k, to avoid unbounded memory use) and classifies them.
  Already-keyed events colliding with each other (`hardBlocked`) is treated as prior corruption
  and aborts the whole run before any write; ordinary legacy blockers are reported but do not
  abort — they are left permanently unkeyed (never deleted/merged/chosen), which is safe because
  the partial index already excludes non-string keys by design.
- `--execute`: backfills only `eligible` rows via conditional `updateOne({_id, idempotencyKey:
  null}, ...)` (never unconditional), re-counts remaining unkeyed rows and verifies it equals
  exactly the known blocker count before creating the index, and only then creates it.
- Dry-run remains the default; `--execute` still goes through the shared allowlist guard.
  **Not executed against any database in this session.**

**B. Real MongoDB integration coverage** (`tests/integration/g5.inboxIdempotency.mongo.test.js`)
Rewritten: `beforeEach` now calls `clearTestDb()` (existing destructive-test safeguards; only
valid against a `tycoon_test_*` replica set with explicit opt-in), and every receipt number is
randomized per test so repeated/parallel runs never collide with old data. Added real-Mongo cases:
concurrent identical delivery (20-way), concurrent conflicting delivery (5-way, asserts the
surviving original plus bounded conflict evidence), a lease-fencing case that actually calls
`claimIngestionEvent` then asserts a fenced `completeIngestionEvent` returns null, and the
canonical fail-closed case now actually invokes `claimIngestionEvent()` +
`processClaimedEvent()` (previously it skipped straight to `processClaimedEvent`) and asserts
zero `MpesaTransaction` rows. **Still correctly skipped in this environment** — no
`tycoon_test_*` replica set / `TYCOON_ALLOW_DESTRUCTIVE_TEST_DB=1` available; not claimed as run.

**C. Ingestion recovery** (`src/services/mpesa/mpesaIngestion.service.js`,
new `src/jobs/mpesaIngestionRecovery.job.js`, `src/jobs/scheduler.js`)
`reclaimExpiredProcessingEvents()` previously only found expired-`PROCESSING` rows and called
`claimIngestionEvent` without ever processing them. Replaced with a full recovery lifecycle:
- Recovers orphaned `RECEIVED` (older than a 30s minimum-age guard, so the live synchronous
  request path always gets first chance at a freshly-persisted event), `FAILED_RETRYABLE` events
  whose `nextAttemptAt` has elapsed, and expired-lease `PROCESSING` events — using the *same*
  `claimIngestionEvent` conditional CAS the live path uses, so concurrent recovery workers (or a
  worker racing the live request path) can never both process the same event.
- `reconstructNormalizedObservation(event)` rebuilds the normalized observation only from the
  event's own persisted/redacted fields (`sourceChannel`, `businessShortCode`, `receiptNumber`,
  `payloadDigest`, `payloadRedacted.*`) — never from an unavailable raw callback body. Returns
  null (quarantine with `recovery_insufficient_data`, never a guess/loop) when the minimum fields
  are absent.
- Recovered events are run through the unmodified `processClaimedEvent()` — same canonical
  fail-closed gate, same lease fencing, same merchant-profile quarantine paths.
- `nextRetryBackoffMs(attempts)` gives exponential backoff (30s base, capped at 30min); a
  recovery-time processing failure reschedules `FAILED_RETRYABLE` with `nextAttemptAt` set
  instead of retrying immediately. `MAX_RECOVERY_ATTEMPTS` (8) marks an event `FAILED_TERMINAL`
  instead of looping forever.
- Never retries `QUARANTINED` events (conflict or terminal).
- Wired into the existing Redis-locked scheduler (`src/jobs/scheduler.js`) as
  `mpesaIngestionRecoveryJob`, its own 5-minute interval and 2-minute lock TTL, following the
  exact same `runSafely`/`withLock` convention as every other background job — no new
  distributed-lock mechanism introduced.
- Recovery never bypasses inbox readiness (still goes through `claimIngestionEvent`'s own CAS and
  `processClaimedEvent`'s gates) or the canonical/posting gates.

**D. Readiness gate correction (raised mid-correction, addressed in this same checkpoint):**
`report.gates.inboxIdempotency` previously went true as soon as the partial unique index
structurally existed in MongoDB — true even if the historical backfill had only partly run (e.g.
an interrupted migration, or the index created by hand). Fixed in
`src/utils/mpesaIndexReadiness.js`: `inspectMpesaIndexes()` now additionally requires
`hasCompleteInboxBackfillCoverage(db)` — zero legacy rows that have enough data to derive a key
(`sourceChannel` + `payloadDigest`, present) but still lack `idempotencyKey` — before the gate
(and therefore `isInboxIdempotencyReady()`, which trusts the cached gate) can go true. Fails
closed on any query error. This also means legacy rows the migration deliberately left unkeyed
as ambiguous/colliding keep the gate false indefinitely until a human resolves them — intentional,
matching "never silently choose between historical events".

**Tests run (this correction only — focused, not the full repo suite, per instruction):**
- `NODE_OPTIONS=--experimental-vm-modules npx jest tests/unit/mpesa/inboxMigrationAndCallers.test.js`
  → 23/23 passed (migration pure-function + caller tests, rewritten for the new backfill design).
- `NODE_OPTIONS=--experimental-vm-modules npx jest tests/unit/mpesa/ingestionRecovery.test.js`
  → 11/11 passed.
- `NODE_OPTIONS=--experimental-vm-modules npx jest tests/unit/mpesa/inboxIdempotencyCoverageGate.test.js`
  → 5/5 passed (new — proves partial backfill cannot satisfy readiness).
- `NODE_OPTIONS=--experimental-vm-modules npx jest tests/unit/mpesa tests/integration/g5.inboxIdempotency.mongo.test.js`
  → **14 unit suites / 111 tests passed**; integration suite **1 suite / 5 tests skipped**
  (correctly gated — no disposable `tycoon_test_*` replica set / opt-in here).
- Full repo-wide unit suite and lint **not re-run** this checkpoint per the instruction to fix
  only the four failing tests and the coverage-gate correction, not repeat full verification.

**Confirmed untouched:** `main`; Render; no Daraja call, callback simulation, or Pull
registration/query; callback routes stay closed (unchanged this checkpoint); no live migration
executed (`--execute` never passed; only pure functions and a fake `db` exercised in tests);
`canonicalReceiptIdentity` still hard-false; `G5_MPESA_POSTING_ENABLED` unset.

**Not committed or pushed in this checkpoint** — working tree only, per instruction to stop after
updating this checkpoint.

**Next action:** commit this correction as one coherent commit on `fix/g5-daraja-pull-contract`,
then push normally (no force) once instructed; no PR/merge.
