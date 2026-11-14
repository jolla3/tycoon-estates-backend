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
