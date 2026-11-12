# G4 Correction and Verification Report

**Date:** 2026-11-11  
**Workspace:** `/home/workdir/artifacts/g4`  
**Basis:** `docs/G4_FINAL_IMPLEMENTATION_REVIEW.md` P1/P2 findings

---

## Nine review items — final status

| # | Finding | Status |
|---|---------|--------|
| 1 | P1-1 Durable secrets management | **FIXED BUT NOT EXECUTED** (code + unit tests written; Jest/npm install could not complete in this environment) |
| 2 | P1-2 Checkpoint after failed ingestion | **FIXED BUT NOT EXECUTED** (policy corrected in `bankSync.service.js`; unit policy tests written) |
| 3 | P1-3 INS credential scope | **PARTIALLY ADDRESSED** — scope established as **application-level** from available Co-op evidence; platform `COOP_INS_BASIC_SECRET` retained; documented; not invented as per-connection |
| 4 | P2-1 Callback route readiness | **FIXED BUT NOT EXECUTED** (operational readiness **or** `COOP_WEBHOOK_LAB_OVERRIDE=1`; default closed) |
| 5 | P2-2 Estate reassignment | **FIXED BUT NOT EXECUTED** (`allowEstateReassignment` required; audit `BANK_ACCOUNT_ESTATE_REASSIGNED`) |
| 6 | P2-3 BankConnection index migration | **FIXED BUT NOT EXECUTED** (additive migration script; dry-run default) |
| 7 | P2-4 Claim completion ownership | **FIXED BUT NOT EXECUTED** (claim-token-matched clear/fail only; no cross-owner clear) |
| 8 | P1-4 DB concurrency tests | **PARTIALLY ADDRESSED** — integration tests authored; **NOT RUN** (no Jest binary / disposable Mongo in this environment after install timeout) |
| 9 | FullStatement contract evidence | **FIXED** (documentation updated from supplied OpenAPI facts; list polling remains disabled) |

---

## Files created or modified

### Created
- `scripts/migrations/20261111_g4_bank_connection_indexes.js`
- `tests/unit/secretsManager.backend.test.js`
- `tests/unit/bankSync.checkpointPolicy.test.js`
- `tests/unit/estateReassignment.test.js`
- `tests/unit/webhookExposure.test.js`
- `tests/integration/g4.concurrency.test.js`
- `docs/G4_CORRECTION_AND_VERIFICATION.md` (this file)

### Modified
- `src/services/banking/secretsManager.js` — redis/memory backends; production fail-closed
- `src/config/environment.js` — `BANK_SECRETS_BACKEND`, `COOP_WEBHOOK_LAB_OVERRIDE`, `isTest` export
- `src/server.js` — `assertSecretsBackendConfigured()` at startup
- `src/services/banking/bankSync.service.js` — any failed batch item blocks checkpoint
- `src/routes/webhook.routes.js` — exposure gate; application-level INS Basic; shared ingestion
- `src/services/bank.service.js` — explicit estate reassignment + audit
- `src/utils/validators.js` — `allowEstateReassignment`
- `src/services/banking/transactionIngestion.service.js` — claim-owner-only token clear/fail
- `src/services/connection.service.js` — credentialVersion stored with secrets
- `src/services/banking/providers/coop/coop.mapper.js` — FullStatement C/D `TransactionType`
- `docs/provider-contracts/CONTRACT_EVIDENCE.md` — FullStatement OpenAPI evidence

---

## 1. Durable secrets backend

**Selected backends:**
- **`redis`** — durable relative to app processes; uses existing project Redis (`REDIS_URL`). Key prefix `tycoon:bank:secret:`.
- **`memory`** — local/test only.

**Configuration:**
| Variable | Purpose |
|----------|---------|
| `BANK_SECRETS_BACKEND=redis` | Production / multi-instance |
| `BANK_SECRETS_BACKEND=memory` | Dev/test only |
| `BANK_SECRETS_ALLOW_MEMORY=1` | Required if forcing memory outside non-production defaults |

**Production:** `assertSecretsBackendConfigured()` throws if backend is missing or `memory`. Invoked from `src/server.js` before DB connect.

**Not claimed:** Redis is not a dedicated enterprise HSM/Vault product. Operators may later plug another backend behind the same port. MongoDB still stores **only** `credentialsRef` + `credentialVersion`.

---

## 2. Checkpoint failure policy

Any `ingestNormalizedTransactionBatch` result with `ok: false` sets `pageFailed` and **does not** advance the checkpoint. Successful items in the same page remain stored; replays remain idempotent. Conservative FullStatement behavior: retain previous checkpoint for the window when any required item fails.

---

## 3. INS credential scope

**Conclusion from available evidence:** inbound Co-op INS Basic is treated as an **application-level endpoint credential** (`COOP_INS_BASIC_SECRET`), distinct from per-connection outbound OAuth material in the secrets manager.

**Account resolution** still maps `AccountNumber` → connected `BankAccount` → client ownership before ingestion.

**Unresolved:** official Co-op document explicitly stating multi-tenant vs single-app INS secret issuance was not obtained beyond existing project/docs references. Callback capability remains **non-operational** without lab override / readiness.

---

## 4. Callback exposure

Route opens only if:
- Co-op webhook capability is `operationalReady`, **or**
- `COOP_WEBHOOK_LAB_OVERRIDE=1` (default **false**)

Lab mode does **not** skip Basic verification, ownership checks, validation, quarantine, or shared ingestion.

---

## 5. Estate reassignment

Ordinary reconnect with a different `estateId` → `CONFLICT` unless `allowEstateReassignment: true`.  
Audit action: `BANK_ACCOUNT_ESTATE_REASSIGNED` with previous/new estate, connection, provider.  
`BankAccount._id` preserved; historical transactions keep ingest-time estate.

---

## 6. BankConnection indexes

Migration: `scripts/migrations/20261111_g4_bank_connection_indexes.js`  
Uses `BANK_CONNECTION_INDEX_SPECS` (non-unique). Dry-run default; `EXECUTE=1` + URI; skips equivalent existing keys; refuses prod-like URI without `ALLOW_PROD=1`.

---

## 7. Claim completion

After reconciliation, claim token is cleared or failed **only** when `processingClaimToken` matches the worker’s token. Stale owners cannot clear newer claims. G3 reconciliation logic unchanged; no direct Payment/Ledger writes from banking layer.

---

## 8. Tests

### Commands intended

```bash
cd /home/workdir/artifacts/g4
npm ci --ignore-scripts   # use lockfile
NODE_ENV=test BANK_SECRETS_BACKEND=memory BANK_SECRETS_ALLOW_MEMORY=1 \
  NODE_OPTIONS=--experimental-vm-modules npm test -- --runInBand \
  --testPathPattern='secretsManager.backend|bankSync.checkpoint|estateReassignment|webhookExposure|providerAdapters|normalizedTransaction|g4.concurrency'
```

Integration concurrency requires disposable Mongo:
```bash
G4_TEST_MONGODB_URI='mongodb://127.0.0.1:27017/tycoon_g4_test' \
  NODE_OPTIONS=--experimental-vm-modules npm test -- --runInBand --testPathPattern=g4.concurrency
```

### Actual results in this environment

| Suite | Result |
|-------|--------|
| `node --check` on corrected modules | **SYNTAX_OK** |
| `npm ci` / `npm install` | **Timed out / killed** — incomplete |
| Jest unit tests | **NOT RUN** — `node_modules/.bin/jest` missing |
| Mongo concurrency integration | **NOT RUN** — no disposable Mongo + no Jest |

Statuses are therefore **FIXED BUT NOT EXECUTED** for code-backed items, not **FIXED AND TESTED**.

---

## Remaining external blockers

1. Complete dependency install and execute unit + integration tests on operator infrastructure  
2. Choose production secrets backend (`redis` or external SM) and set `BANK_SECRETS_BACKEND`  
3. Co-op sandbox: OAuth scopes/TTL, live FullStatement fixtures, INS operational readiness  
4. AccountTransactions **list** API contract (still disabled)  
5. KCB / EQUITY / NCBA verified contracts if required  
6. Operator execution of additive migrations on target DBs  

---

## Final engineering acceptance verdict

**CONDITIONALLY ACCEPTED FOR ENGINEERING MERGE INTO LAB / NEXT VALIDATION**

- Review P1/P2 **code defects addressed** in workspace.  
- **Not** production-ready.  
- **Not** “FIXED AND TESTED” for concurrency or secrets backends under load.  
- Provider operational readiness remains **false** without sandbox evidence.  

Batches 01–05 preserved; G3 sole financial authority preserved; AccountTransactions list polling remains disabled; physical `{provider, accountNumberHash}` unique identity preserved.

---

*End of correction report.*

## Verification refresh — 2026-11-12

This section supersedes the earlier "FIXED BUT NOT EXECUTED" status table and historical environment test results above.

### Current finding status

| Finding | Current status | Evidence / remaining limit |
|---|---|---|
| P1-1 Durable credential storage | **Implemented and tested** | Encrypted MongoDB `BankCredential` persistence and connection lifecycle were exercised against MongoDB. Encryption-key custody, backup and production rotation procedures remain deployment responsibilities. |
| P1-2 Checkpoint after failed ingestion | **Fixed and unit-tested** | Failed required ingestion prevents checkpoint advancement; checkpoint policy tests passed. |
| P1-3 INS callback credential scope | **Contract-limited, explicitly documented** | Platform/application-level `COOP_INS_BASIC_SECRET` is used based on current evidence. Per-connection callback credentials are not claimed or invented. Obtain definitive provider documentation if the issuance model must be proven further. |
| P1-4 Concurrency proof | **Integration-tested** | Five real replica-set tests passed: compound unique identity, concurrent claim winner, stale claim rejection and sync-lease fencing. |
| P2-1 Readiness gates | **Fixed and tested** | COOP connection/account lab access requires `COOP_BANK_LAB_MODE=1` outside production. Webhook lab exposure requires its separate override outside production. Production lab overrides are rejected. |
| P2-2 Estate reassignment | **Implemented and unit-tested** | Explicit reassignment flag and dedicated audit behavior are covered by the estate reassignment test. |
| P2-3 BankConnection indexes | **Migration present; deployment unverified** | Additive migration exists. It has not been certified as executed against the eventual target deployment database. |
| P2-4 Claim ownership | **Unit-tested; crash-recovery limit remains** | Claim handoff and ownership contracts passed unit tests. This is not a substitute for process-crash fault injection under production-like load. |
| P2-5 Account validation semantics | **Open provider-contract limitation** | Domain-level invalid-account response semantics remain unverified without provider documentation/sandbox evidence. |

### Actual test evidence

| Verification | Result |
|---|---|
| Focused banking/readiness regression selection | **7 suites, 49 tests passed** |
| Non-destructive runtime suite | **41 suites passed; 269 tests passed; 10 suites and 92 tests skipped** |
| Real MongoDB concurrency integration | **1 suite, 5 tests passed** against a disposable replica-set database |
| Real Express + MongoDB HTTP lifecycle | **1 suite, 2 tests passed** against a disposable replica-set database |
| HTTP integration cleanup | Test-owned records and sessions removed; disposable database dropped |
| Original application repository | Remained clean during candidate/runtime workflow |

The non-destructive suite deliberately did not enable destructive database tests. The separate G4 HTTP and concurrency runs used isolated test databases. The unrelated deposit-idempotency integration suite was not executed as part of this G4 verification refresh.

### Provider readiness remains unchanged

| Provider | Adapter implementation | Overall operational readiness |
|---|---:|---:|
| COOP | Yes | **False** |
| KCB | No (disabled shell) | **False** |
| EQUITY | No (disabled shell) | **False** |
| NCBA | No (disabled shell) | **False** |

The COOP lab flags permit isolated non-production testing only. They do not change the readiness profiles or establish sandbox verification.

### Current verdict

**G4 candidate is suitable for continued isolated engineering and controlled provider sandbox work. It is not production-ready.**

Outstanding before production use:

1. Complete COOP OAuth/token lifecycle and account-validation contract verification.
2. Run and retain evidence from the actual Co-op sandbox, including FullStatement fixtures and callback behavior.
3. Keep AccountTransactions list polling disabled until its item schema is verified.
4. Complete production secrets-key custody, backup and rotation procedures.
5. Execute additive migrations under the deployment migration procedure and verify the resulting indexes.
6. Obtain definitive provider documentation for any callback credential scope or retry/ack behavior that must be stronger than the current application-level Basic contract.

Local passing tests establish application behavior only. They do not establish provider certification or production operational readiness.
