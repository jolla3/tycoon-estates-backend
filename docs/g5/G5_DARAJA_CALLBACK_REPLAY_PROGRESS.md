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
