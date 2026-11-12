# G4 Final Implementation Review (Batches 01–05)

> **Historical snapshot:** this static review was prepared on 2026-11-11. Its source findings and test-status statements are superseded where they conflict with the dated 2026-11-12 verification refresh at the end of this file.

**Review type:** Audit only — no source modifications  
**Workspace:** `/home/workdir/artifacts/g4`  
**Review date:** 2026-11-11  
**Documents read:** `PRD.md`, `architecture.md`, `architecture-summary.md`, `SOURCE_CROSSWALK.md`, `docs/provider-contracts/CONTRACT_EVIDENCE.md`  
**Source of truth for claims:** actual workspace source (not batch completion narratives)

---

## 1. Executive verdict

**CONDITIONALLY READY** for controlled further engineering and sandbox planning — **not** production ready, **not** “READY FOR CONTROLLED SANDBOX VALIDATION” without addressing the P1 defects below.

The G4 foundation is largely aligned with the locked architecture: connection ownership model, physical account identity, normalized contract with explicit direction, shared ingestion, processing claims, per-account sync fencing, quarantine ACK rules, multi-provider registry with honest non-operational KCB/EQUITY/NCBA shells, and G3 remaining the sole financial posting authority.

Critical/high gaps remain: in-process memory secrets backend, checkpoint advancement after non-CONFLICT ingest failures, webhook verification not connection-scoped, and absence of executed behavioral/concurrency tests.

---

## 2. Review baseline

| Item | Evidence |
|------|----------|
| Recorded GitHub baseline | `SOURCE_HEAD.txt`: `e0b49c2f122be7ae3ed14eaba9eecfeacee7ce13` (main, v2.0.3) |
| Workspace git | Not a git worktree at `/home/workdir/artifacts/g4` (no local branch/HEAD beyond recorded baseline) |
| Batches 01–05 presence | Present: `BankConnection`, extended `BankAccount`/`BankTransaction`, secrets port, factory, ingestion, claims, sync coordination, quarantine, COOP + disabled KCB/EQUITY/NCBA adapters |
| `package.json` / lockfile | Present; no evidence in this review of dependency installs during G4 batches (Jest still absent) |
| Credentials / `.env` in tree | None found under workspace for this review |
| G3 models/services | Not rewritten for parallel accounting; banking adapters do not call `Payment`/`Ledger` create |

### Core artifacts inspected (non-exhaustive but material)

- Models: `BankConnection.js`, `BankAccount.js`, `BankTransaction.js`, `BankCallbackQuarantine.js`
- Banking core: `secretsManager.js`, `bank.factory.js`, `normalizedTransaction.js`, `transactionIngestion.service.js`, `processingClaim.js`, `syncCoordination.service.js`, `bankSync.service.js`, `callbackQuarantine.service.js`, `connection.service.js`, `bank.service.js`
- Providers: `coop/*`, `kcb/kcb.provider.js`, `equity/equity.provider.js`, `ncba/ncba.provider.js`, `disabledProvider.js`
- Routes/jobs: `webhook.routes.js`, `bankSync.job.js`, `connection.routes.js`
- Migrations: `20261111_g4_bank_connection_account_fields.js`, `20261111_g4_bank_transaction_provenance.js`, `20261111_g4_bank_sync_and_quarantine.js`
- Tests under `tests/unit/` matching bank/sync/provider/normalized patterns (~562 LOC total for those files)

---

## 3. Findings by severity

### P0 — Critical

**None verified** from static source review.

No path was found where a provider adapter directly creates `Payment`, `PaymentAllocation`, `RentCharge`, or `Ledger`. Duplicate identity persistence includes ownership checks against `clientId` / `estateId` / `bankAccountId`. Direction has no schema default of `CREDIT`. Cross-client physical account assignment is rejected in `connectAccount`.

*(Live concurrent race outcomes were not executed — residual risk is classified under P1/P2 and test gaps, not as proven P0 corruption.)*

---

### P1 — High

#### P1-1. Secrets manager is process memory only

- **Where:** `src/services/banking/secretsManager.js` (`memoryStore` `Map`)
- **Behavior:** `putConnectionSecret` / `getConnectionSecret` persist only in the current Node process heap.
- **Risk:** Multi-instance deployments, restarts, and horizontal scale lose or silo credentials. Architecture requires a secrets-manager mechanism; the port is real, but the only backend is unsuitable as a production credential store. Accidental production use would break auth or encourage unsafe workarounds (e.g. reintroducing env globals).
- **Scenario:** API instance A creates a connection (secret in A’s memory); instance B handles sync → `BankAuthFailed: Connection credential material not found`.
- **Correction:** Inject a durable secrets backend (e.g. Vault/cloud SM) behind the same port; fail startup in production if only memory backend is configured.

#### P1-2. Sync checkpoint can advance despite rejected page items

- **Where:** `src/services/banking/bankSync.service.js` (batch result handling after `ingestNormalizedTransactionBatch`)
- **Behavior:** Only `CONFLICT` failures set `pageFailed`. `INVALID_REQUEST` and other soft failures are logged/skipped; if the strategy supplies `checkpointCandidate`, checkpoint still advances.
- **Risk:** Violates architecture rule that a failed/partially persisted page must not advance past unaccepted transactions. Equal-timestamp / mapping-failure items can be skipped permanently once `acceptedThrough` moves forward.
- **Scenario:** FullStatement returns 50 rows; 5 fail direction/identity validation; checkpoint `acceptedThrough` still set to window end → those 5 never retried by date-window resume logic that only overlaps one day.
- **Correction:** Treat any non-ok batch result (or any non-persisted required item) as page failure, or advance checkpoint only to the minimum accepted contiguous position (with explicit policy).

#### P1-3. Webhook authenticity is global env secret, not connection-scoped

- **Where:** `src/routes/webhook.routes.js` — `new CoopBankProvider({ insBasicSecret: env.COOP_INS_BASIC_SECRET })`
- **Behavior:** Imports `getConnectionSecret` / `BankConnection` but does not use them for verification. All tenants share one platform Basic secret for Co-op INS.
- **Risk:** Architecture requires customer-specific callback credentials scoped to the connection where the provider contract requires it. Current design cannot isolate per-connection callback secrets and couples all clients to one env value.
- **Scenario:** Rotating secret for one client impacts all; cannot grant distinct INS credentials per `BankConnection`.
- **Correction:** After account resolution (or via provider account mapping), verify with connection-scoped material from secrets manager; keep rejecting unauthenticated requests without quarantine.

#### P1-4. No executed concurrency/behavioral proof for claims, fences, or idempotency

- **Where:** `tests/unit/*` (schema/policy/redaction tests only); Jest not available (`jest: not found`)
- **Behavior:** Unit files assert schema indexes, readiness flags, redaction, strategy policy. They do not drive concurrent `acquireSyncLease` / `claimBankTransaction` / duplicate `persistNormalizedTransaction` against Mongo.
- **Risk:** Architecture acceptance depends on atomic conditional updates. Static review of query shapes is favorable, but production concurrency bugs would be invisible.
- **Correction:** Run integration tests on disposable replica set covering lease fence, claim expiry takeover, and compound unique race (11000 path).

---

### P2 — Medium

#### P2-1. Registry `webhook: true` / `statementImport: true` vs `operationalReady: false`

- **Where:** `bank.factory.js` `BANK_PROVIDER_REGISTRY.COOP`; `webhook.routes.js` gate uses `caps.webhook`, not `operationalReady`
- **Behavior:** Readiness profile correctly reports non-operational detail, but HTTP webhook path opens when `implemented && webhook`.
- **Risk:** Operators may interpret capability flags as production authorization. Controlled exposure may be intentional for lab use, but it is inconsistent with strict operational gating.
- **Correction:** Gate external routes on `operationalReady` or an explicit `ops.allowUnverifiedCoopWebhook` config defaulting false.

#### P2-2. Estate change on same-client reconnect is implicit

- **Where:** `bank.service.js` `connectAccount` — on existing physical account, sets `bankAccount.estateId = estateId`
- **Behavior:** `_id` preserved (good). Estate reassignment is not a separate audited action type; audit is general `BANK_ACCOUNT_CONNECTED` with metadata.
- **Risk:** Architecture asks for explicit, auditable estate reassignment. Historical `BankTransaction.estateId` remains at ingest-time (good), but operational confusion is possible.
- **Correction:** Detect estateId change; require explicit flag or emit dedicated audit action `BANK_ACCOUNT_ESTATE_REASSIGNED`.

#### P2-3. `BankConnection` collection indexes lack migration script

- **Where:** Schema indexes in `BankConnection.js`; migrations cover bankaccounts/transactions/quarantine only
- **Risk:** Production may miss non-unique `{clientId,provider,status}` indexes if relying solely on runtime ensure (project avoids destructive startup sync).
- **Correction:** Additive migration creating BankConnection indexes with dry-run default.

#### P2-4. Claim completion split between reconcile mutation and claim token clear

- **Where:** `transactionIngestion.service.js` `processBankTransaction`
- **Behavior:** Relies on `reconciliationService.reconcile` to move state; then best-effort clears claim token. Owner-only `completeClaim` helper exists but is not the primary POSTED path.
- **Risk:** If reconcile sets POSTED without matching claim token semantics, or crashes mid-way, observability of claim ownership weakens (likely still retryable, not double-post if G3 is idempotent — **not verified here**).
- **Correction:** Have reconcile return outcome; ingestion always transitions claim via `completeClaim` / `failClaim` only.

#### P2-5. Co-op `validateAccount` does not interpret domain-level “invalid account” beyond `coopPost` success

- **Where:** `coop.provider.js` `validateAccount` → always `{ valid: true, raw: data }` after successful MessageCode
- **Risk:** If provider returns success envelope with an embedded invalid flag (unverified), code would still activate. Currently mitigated because `coopPost` throws on non-success MessageCode.
- **Correction:** When official validation response fields are verified, assert them explicitly before activation.

#### P2-6. Memory secrets + multi-instance makes connection create/sync sticky to one process

- Related to P1-1; operational symptom is intermittent auth failures under scale-out.

---

### P3 — Low

#### P3-1. Unused imports in `webhook.routes.js`

`createBankProviderForConnection`, `getConnectionSecret`, `BankConnection` imported but unused — dead code / incomplete connection-scoped verify attempt.

#### P3-2. `getBankProvider('COOP')` still constructs empty-credential adapter

Documented deprecated path; acceptable for tests but should not be used for customer traffic (factory comments state this).

#### P3-3. Quarantine payload redaction is heuristic

Sensitive key regex is reasonable; not a formal allowlist. Acceptable for quarantine given architecture, not a substitute for field-level classification.

#### P3-4. Documentation drift

Batch reports claimed various “complete” states; readiness correctly remains non-operational for live banks. No code change required for this audit item beyond operator communication.

---

## 4. Architecture area assessment

### A. BankConnection and account ownership

| Requirement | Status |
|-------------|--------|
| One client + one provider per connection | **Met** (`clientId`, `provider` required) |
| Multiple connections same client/provider | **Met** (non-unique indexes; `_id` identity) |
| Physical identity `{provider, accountNumberHash}` unique | **Met** (schema unique index) |
| Cross-client physical account blocked | **Met** (`connectAccount` conflict) |
| Same-client reconnect reuses `_id` | **Met** |
| Legacy `connectionId` null allowed | **Met** |
| Historical txn ownership preserved | **Met** (`BankTransaction` stores ingest-time client/estate/account; `connectionId` first-accepted) |
| Estate reassignment explicit/audited | **Partial** (P2-2) |

### B. Credentials and authentication isolation

| Requirement | Status |
|-------------|--------|
| Mongo holds ref + version only | **Met** |
| No provider-name token singleton for customer path | **Met** (`createBankProviderForConnection` new instances) |
| No env fallback for customer clientId/secret/password on COOP provider | **Met** (config-only; baseUrl may use env) |
| Durable secrets manager | **Not met** (P1-1 memory only) |
| API strips `credentialsRef` | **Met** (`toJSON` / sanitize) |
| Webhook secret connection-scoped | **Not met** (P1-3) |

### C. Provider registry and readiness

| Provider | adapterPresent | implemented | operationalReady (registry) |
|----------|----------------|-------------|------------------------------|
| COOP | true | true | false |
| KCB | true | false | false |
| EQUITY | true | false | false |
| NCBA | true | false | false |

Disabled providers throw `BANK_CAPABILITY_UNSUPPORTED` — **no fallthrough to COOP**. Readiness profiles add multi-dimensional blockers. **Honest overall.** External route gating still uses capability booleans (P2-1).

### D. Normalized transaction contract and identity

| Requirement | Status |
|-------------|--------|
| Explicit CREDIT/DEBIT only | **Met** (validator + required schema enum, no default) |
| TransactionDate ≠ ValueDate | **Met** (separate fields through model/mapper helpers) |
| FullStatement credit/debit direction helper | **Met** (`directionFromCreditDebitAmounts`) |
| AccountTransactions schema treated unverified | **Met** (registry `polling: false`; strategy disables list poll) |
| Unique `{provider, providerTransactionId}` | **Met** |
| Duplicate ownership check | **Met** |
| No narration/amount fallback identity | **Met** (missing providerTransactionId rejected) |

### E. Shared ingestion and claims

| Requirement | Status |
|-------------|--------|
| Single pipeline for poll path and webhook | **Met** (`ingestNormalizedTransaction`) |
| Atomic claim on RECEIVED/FAILED_RETRYABLE | **Met** (conditional `findOneAndUpdate`) |
| Owner-only fail/complete helpers | **Met** (token match); primary POSTED path partially bypasses `completeClaim` (P2-4) |
| DEBIT not auto rent | **Met** → `MANUAL_REVIEW` |
| G3 sole financial authority | **Met** (handoff to `reconciliationService.reconcile` only) |

### F. Synchronization, checkpoints, fencing

| Requirement | Status |
|-------------|--------|
| Shared manual + scheduled coordinator | **Met** (`bankSyncService` + job) |
| Lease + fenceGeneration `$inc` | **Met** |
| Checkpoint conditional on owner+fence | **Met** |
| COOP FullStatement window strategy | **Present** |
| AccountTransactions operational poll | **Disabled** |
| Partial failure must not advance checkpoint | **Not fully met** (P1-2) |
| Concurrent lease tests | **Not executed** (P1-4) |

### G. Callbacks and quarantine

| Requirement | Status |
|-------------|--------|
| Unauthenticated rejected, not quarantined | **Met** (401) |
| Authenticated unprocessable → quarantine then ACK | **Met** |
| Neither ingest nor quarantine → non-success | **Met** (500) |
| Shared ingestion on success path | **Met** |
| Verified crypto beyond Basic | **Not claimed**; Basic only — correct given evidence |
| Connection-scoped verify | **Not met** (P1-3) |

### H. Migrations and indexes

| Migration | Safety posture |
|-----------|----------------|
| `20261111_g4_bank_connection_account_fields.js` | Additive; dry-run default; no legacy connection invention |
| `20261111_g4_bank_transaction_provenance.js` | Additive; unique identity unchanged |
| `20261111_g4_bank_sync_and_quarantine.js` | Additive indexes |
| BankConnection index migration | **Missing** (P2-3) |
| Destructive startup index sync for G4 uniques | **Not introduced** (aligned with G3 discipline) |

Schema index declarations ≠ production deployment proof.

---

## 5. Cross-batch integration findings

1. **Batch 02 secrets port + Batch 04/05 multi-instance ops:** Memory backend breaks the connection-scoped auth story under real deploy topology (P1-1).
2. **Batch 03 ingest soft-fail + Batch 04 checkpoint:** Soft-skipped normalized rows still allow `acceptedThrough` movement (P1-2).
3. **Batch 02 connection-scoped INS intent + Batch 04 webhook:** Route still verifies with `env.COOP_INS_BASIC_SECRET` only (P1-3).
4. **Batch 05 readiness honesty + route gates:** Profiles say non-operational; webhook capability flag still opens the route (P2-1).
5. **Entitlements vs registry:** COOP `poll: false`, `statement: true` → connected accounts get `statement` entitlement; sync requires poll **or** statement — consistent with FullStatement strategy.
6. **First-accepted `BankTransaction.connectionId` vs later reconnect:** Provenance not rewritten — aligned with architecture.

---

## 6. Test and verification results

| Check | Result |
|-------|--------|
| Jest unit/integration suite | **NOT RUN** — `sh: 1: jest: not found` (no `node_modules`; install forbidden by prior batch rules and this audit) |
| Syntax checks historically reported in batches | Favorable for touched files; **not re-proof of behavior** |
| Concurrency tests (lease/claim/idempotency race) | **Absent** as executable proofs |
| Provider fixtures from verified sandbox payloads | **Absent** (synthetic/schema tests only; contract evidence doc records gaps) |
| Security isolation tests (cross-client) | Schema/unit level only; no DB integration |

**Do not treat any G4 batch test suite as passed.**

---

## 7. Provider operational-readiness assessment

| Provider | Code complete for lab paths | Contract verified | Sandbox verified | Operational |
|----------|----------------------------|-------------------|------------------|-------------|
| COOP | Partial (statement/webhook/auth code paths) | Partial (FullStatement direction helpers; gaps on scopes, list schema, ACK) | **No** | **No** |
| KCB | Disabled shell only | **No** | **No** | **No** |
| EQUITY | Disabled shell only | **No** | **No** | **No** |
| NCBA | Disabled shell only | **No** | **No** | **No** |

Evidence: `docs/provider-contracts/CONTRACT_EVIDENCE.md` (access date 2026-11-11).

---

## 8. External dependencies still blocking operational use

1. Durable secrets backend selection and deployment  
2. Co-op portal scopes, token lifecycle, sandbox credentials  
3. Verified AccountTransactions item schema before enabling list polling  
4. Co-op callback retry/ACK contract and per-connection INS credentials  
5. Project-owned KCB/Equity/NCBA API contracts if those banks are required  
6. Disposable Mongo replica integration tests for fence/claim/idempotency  
7. Operator-run additive migrations on target environments  

---

## 9. Recommended correction order

1. **P1-1** — Production-safe secrets backend + boot fail-closed if missing  
2. **P1-2** — Checkpoint policy: no advance when any required item failed ingest  
3. **P1-3** — Connection-scoped webhook verification after account resolution  
4. **P1-4** — Integration tests for lease fence, claims, compound idempotency  
5. **P2-1** — Align HTTP gates with operational readiness / explicit lab flags  
6. **P2-2 / P2-3 / P2-4** — Estate audit clarity, BankConnection index migration, claim completion ownership  

---

## 10. Final release-readiness verdict

### **CONDITIONALLY READY**

**Meaning:**  
- No **verified P0** cross-client financial corruption or direct G3 bypass was found in static review.  
- **P1** defects block safe multi-instance production use and safe checkpoint semantics.  
- Provider contracts and sandbox validation remain incomplete by design of Batch 05 honesty.  

**Not selected:**  
- `READY FOR CONTROLLED SANDBOX VALIDATION` — would require P1-1–P1-3 addressed (or explicitly accepted lab limitations documented) plus a secrets approach suitable for the lab topology.  
- `PRODUCTION READY` — not appropriate.  
- `NOT READY` — reserved for confirmed critical data-corruption defects; none proven in this static audit.

---

*End of audit. No source files were modified during this review.*

## Verification refresh and current release verdict — 2026-11-12

This section is the current implementation review. It supersedes contradictory findings and test-status statements in the historical 2026-11-11 audit above.

### Current findings

| Area | Current result |
|---|---|
| Credential persistence | Encrypted MongoDB `BankCredential` backend implemented; real Mongo persistence and lifecycle tests passed. Production key custody/rotation remains a deployment control. |
| Checkpoint policy | Required ingestion failures block checkpoint advancement; policy regression tests passed. |
| INS callback authentication | Platform/application-level Basic credential retained according to current contract evidence. Per-connection INS scope is not established by the available documentation. |
| Transaction identity and claims | Compound unique identity and competing claim behavior passed real replica-set integration tests. |
| Sync fencing | Stale claim owner and stale sync lease cannot supersede the newer owner/checkpoint in the executed concurrency tests. |
| Connection lifecycle | Real HTTP + Mongo integration verified create, encrypted persistence, response redaction, tenant isolation, account validation/linking, credential rotation and disconnect. |
| Provider readiness | Registry remains honest: COOP implemented but not operationally ready; KCB/EQUITY/NCBA disabled. |
| Lab authorization | Explicit COOP bank and webhook lab overrides are non-production-only. Production lab bypasses are rejected. |
| Estate reassignment | Explicit opt-in and audit behavior covered by unit tests. |
| BankConnection indexes | Additive migration exists; target deployment execution remains unverified. |
| Claim completion crash behavior | Ownership/claim contract tests pass; production-like process-crash fault injection remains unverified. |
| COOP account-validation semantics | Still limited by unverified provider response semantics and missing sandbox evidence. |

### Executed verification

| Run | Result |
|---|---|
| Focused banking/readiness regression | 7 suites, 49 tests passed |
| Non-destructive runtime Jest selection | 41 suites passed, 269 tests passed; 10 suites and 92 tests skipped |
| Mongo concurrency integration | 5/5 passed on a disposable MongoDB replica set |
| G4 HTTP integration | 2/2 passed using the real Express app and disposable MongoDB replica set |
| HTTP cleanup | Session records and test-owned tenant records cleaned; disposable database dropped |
| Original repository | Clean; no changes promoted into the original repository |

The 41-suite non-destructive run did not authorize destructive database integration tests. The G4 HTTP and concurrency integration tests were separately executed against disposable databases. The unrelated deposit-idempotency integration suite remains outside this G4 verification result.

### Effective COOP authorization policy

- `implemented` does not mean `operationalReady`.
- COOP connection creation and account linking may use `COOP_BANK_LAB_MODE=1` only when `NODE_ENV` is not `production`.
- COOP FullStatement sync accepts the `statement` entitlement; the unverified AccountTransactions polling path remains disabled. Entitlements are revalidated during the sync.
- Webhook exposure requires webhook operational readiness or `COOP_WEBHOOK_LAB_OVERRIDE=1` outside production.
- Neither lab flag changes provider readiness or bypasses authentication, ownership checks, account validation or ingestion controls.

### Current release verdict

**Suitable for continued isolated engineering and controlled provider sandbox work. Not production-ready.**

COOP overall operational readiness remains false. Actual sandbox verification, account-validation response semantics, production secrets-key operations and target-environment migration execution remain outstanding. No passing local test is presented as evidence of provider sandbox certification.
