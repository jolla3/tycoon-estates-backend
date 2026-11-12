# G4 Source-to-Target Architecture Crosswalk

**Workspace:** `/home/workdir/artifacts/g4`  
**Verified GitHub HEAD:** `e0b49c2f122be7ae3ed14eaba9eecfeacee7ce13` (`v2.0.3`)  
**Task type:** Inspection and documentation only — no application code changes.  
**Evidence class:** **VERIFIED** = observed in workspace source matching HEAD. **PROPOSED** = G4 target behaviour. **BLOCKED BY VERIFICATION** = requires official bank evidence. **UNRESOLVED (technical)** = answerable from engineering design once decisions above are applied, not reopened product questions.

---

## 1. Workspace snapshot verification

| Check | Result |
|-------|--------|
| `SOURCE_HEAD.txt` | Records `e0b49c2f122be7ae3ed14eaba9eecfeacee7ce13` |
| Re-clone of GitHub `main` | HEAD = `e0b49c2f122be7ae3ed14eaba9eecfeacee7ce13` |
| `diff -rq` `src/` vs clone | **No differences** (exit 0) |
| `tests/` vs clone | **No differences** |
| `scripts/` vs clone | **No differences** |
| `package.json` / `package-lock.json` | **Byte-identical** to clone |
| Missing files | **None** relative to HEAD `src/`, `tests/`, `scripts/` |
| Extra files in `g4/` (non-source) | `PRD.md`, `architecture.md`, `architecture-summary.md` (original ZIP baseline), `SOURCE_HEAD.txt`, `README.md`, `.gitignore` |
| `node_modules` / `.git` / `.env` | Absent (as required) |

**Conclusion:** The copied backend tree is a faithful snapshot of GitHub HEAD `e0b49c2`. File counts alone were not relied upon; tree diff against a fresh clone confirms content match.

---

## 2. Banking dependency graph (VERIFIED)

### 2.1 Models

| Path | Role |
|------|------|
| `src/models/BankAccount.js` | Client/estate-scoped account; provider enum; encrypted account number + HMAC lookup hash; `connectionStatus` pending/connected/failed; `lastSyncedAt`; unique `{provider, accountNumberHash}` |
| `src/models/BankTransaction.js` | Normalized bank event; unique `{provider, providerTransactionId}`; processingState machine + claim fields; match fields including `matchedTenancyId`; `rawPayload` |
| `src/models/Payment.js` | `origin` includes `BANK`; sparse unique `bankTransactionId` |
| `src/models/PaymentAllocation.js`, `Ledger.js`, `RentCharge.js`, `Tenancy.js` | G3 financial authority consumed after bank match |

**No `BankConnection` model exists.**

### 2.2 Provider layer

| Path | Role |
|------|------|
| `src/services/banking/bank.interface.js` | Abstract provider contract |
| `src/services/banking/bank.factory.js` | Registry; singleton cache **by provider name only**; only COOP instantiable |
| `src/services/banking/providers/coop/coop.auth.js` | Password grant + Basic client credentials from **process env**; in-process token cache on instance |
| `src/services/banking/providers/coop/coop.client.js` | HTTP post helper + message reference |
| `src/services/banking/providers/coop/coop.schemas.js` | Zod request/payload shapes |
| `src/services/banking/providers/coop/coop.mapper.js` | Webhook + polled normalize; hardcodes `provider: 'COOP'`; `extractAccountNumber` |
| `src/services/banking/providers/coop/coop.provider.js` | Adapter implementing interface; constructs auth from `env.COOP_*` |

### 2.3 Orchestration and finance

| Path | Role |
|------|------|
| `src/services/bank.service.js` | `connectAccount`, `list`, `get`, `sync`, `importStatement`, **`storeAndReconcile`** |
| `src/services/reconciliation.service.js` | Bank-agnostic match → G3 payment posting; sets `processingState` POSTED / MANUAL_REVIEW |
| `src/services/accountingPosting.service.js` | Sole financial multi-doc writer (G3) |
| `src/services/transaction.service.js` | Manual assignment of UNMATCHED bank txns; can set POSTED |
| `src/services/integrityVerifier.service.js` | Reads BankTransaction vs Payment consistency |
| `src/services/platform.service.js` | Surfaces provider list including COOP name |
| `src/services/audit.service.js` | BANK_SYNCED / connection audits |

### 2.4 HTTP, jobs, config, utils

| Path | Role |
|------|------|
| `src/controllers/bank.controller.js` | Connect / list / sync / statement |
| `src/routes/bank.routes.js` | `/bank/accounts*` under auth + clientContext + authorize |
| `src/routes/webhook.routes.js` | `POST /banks/coop/transactions` — Co-op-specific path; hash lookup; idempotent create; reconcile |
| `src/routes/index.js` | Mounts `/bank`; webhook mount elsewhere (app) |
| `src/routes/report.routes.js` | `GET .../bank-transactions` |
| `src/jobs/bankSync.job.js` | All `connectionStatus: 'connected'` accounts → `bankService.sync` |
| `src/jobs/scheduler.js` | Schedules jobs (distributed lock pattern for multi-instance) |
| `src/config/environment.js` | `COOP_BASE_URL`, `COOP_CLIENT_ID`, `COOP_CLIENT_SECRET`, `COOP_USERNAME`, `COOP_PASSWORD`, `COOP_SCOPE`, `COOP_INS_BASIC_SECRET` |
| `src/utils/encryption.js` | AES-GCM encrypt/decrypt; HMAC `hashForLookup` |
| `src/utils/idempotency.js` | `withIdempotency(Model, key, keyField, createFn)` — **single-field** lookup |
| `src/utils/validators.js` | `connectBankAccount.provider` enum `COOP|KCB|EQUITY|NCBA` |
| `src/utils/estateFilter.js` | Estate-scoped query clause |
| `src/utils/ensureIndexes.js` | Imports BankTransaction (index sync on startup path) |
| `src/middlewares/*` | authenticate, authorize, clientContext, validate, webhookRateLimiter |

### 2.5 Tests touching banking (VERIFIED)

| Path | Depends on |
|------|------------|
| `tests/unit/bankRegistry.test.js` | Factory registry; **getBankProvider singleton / implemented flags** |
| `tests/unit/coop*.test.js` | Schemas, mapper, client, account number |
| `tests/unit/encryption.test.js` | hash/encrypt |
| `tests/integration/webhook.test.js` | Dual-client hash isolation; Co-op webhook path |
| `tests/integration/reconciliation.test.js` | BankTransaction → Payment; **duplicate providerTransactionId** |
| `tests/integration/bank.test.js` | Bank account API paths |
| `tests/integration/g3.accounting.test.js` | G3 posting (must remain green) |
| `tests/integration/clientIsolation.test.js` / `estateIsolation.test.js` | Scope boundaries |

### 2.6 Call graph (critical paths)

```
connectAccount
  → Estate ownership check
  → BankAccount.create (pending)
  → getBankProvider(provider)  [singleton]
  → authenticate / validateAccount (errors swallowed → still connected)
  → registerTransactionNotification (log-only for Co-op)
  → connectionStatus = connected | failed

sync / importStatement / bankSyncJob
  → getBankProvider(account.provider)
  → getTransactions | getFullStatement
  → storeAndReconcile
       → withIdempotency(BankTransaction, providerTransactionId only)
       → reconciliationService.reconcile (CREDIT, not POSTED)
            → tenancy resolution + accountingPosting (G3)

webhook POST /banks/coop/transactions
  → getBankProvider('COOP')
  → verifyWebhookSignature (Basic secret)
  → extractAccountNumber (coop.mapper)
  → BankAccount.findOne({ provider:'COOP', connectionStatus:'connected', accountNumberHash })
  → normalizeTransaction
  → withIdempotency(providerTransactionId)
  → reconcile
```

**Callers of `getBankProvider`:** `bank.service.js`, `webhook.routes.js`, tests.  
**Callers of `storeAndReconcile`:** only `bank.service.js` (sync + statement). Webhook **duplicates** the persist+reconcile loop instead of calling `storeAndReconcile`.

---

## 3. Established G4 decisions (carried forward — not reopened)

These are treated as fixed architecture inputs:

1. Provider-neutral domain; Co-op is the first operational adapter only.
2. Multiple independent connections per client/provider are supported.
3. One connection can authorize multiple bank accounts.
4. Customer credentials are stored in MongoDB `BankCredential` as AES-256-GCM encrypted envelopes. `BankConnection.credentialsRef` equals `BankCredential._id`; credentials remain connection-scoped and are never stored as plaintext or supplied through customer-specific global environment fallbacks. This supersedes the earlier external-secrets-manager target.
5. **No** customer-specific global credential fallback.
6. Failed or unavailable account validation **cannot** activate an account (`connected`).
7. Account-level API entitlements must be represented.
8. Retention of bank transaction data beyond ten days is permitted.
9. G3 reconciliation + accounting posting remain the **sole** financial authority.

---

## 4. Source → target crosswalk

### 4.1 Domain models

| Source path | Current behaviour (VERIFIED) | Callers | Dependencies | G4 destination | Class | Requirement | Migration impact | Tests |
|-------------|------------------------------|---------|--------------|----------------|-------|-------------|------------------|-------|
| `src/models/BankAccount.js` | clientId, estateId, provider enum, encrypt+hash, unique provider+hash, status pending/connected/failed, lastSyncedAt | bank.service, webhook, bankSync.job, reports, tests | encryptionUtil, Estate, Client | Add `connectionId`; sync checkpoint/lock metadata; entitlements; status must not become `connected` without successful validation; public DTO remains secret-free | **EXTEND** | Connection ownership, entitlements, fail-closed validation, checkpoints | Additive fields; backfill `connectionId`; unique `{provider, accountNumberHash}` still defines **physical account identity** under a provider | webhook, bank, isolation |
| *(none)* BankConnection | — | — | — | New model: clientId, provider, status, `credentialsRef` pointing to `BankCredential._id`, credential version, auth health and lifecycle metadata | **ADD** | Multi-connection; connection-scoped credentials | New collection; no drop of BankAccount | Connection lifecycle and credential ownership tests |
| *(none)* BankCredential | — | — | — | New `bankcredentials` collection: opaque `_id` reference, clientId, provider, credentialVersion and AES-256-GCM envelope | **ADD** | Encrypted customer credential storage with owner-bound integrity | Create-only imports; `_id` uniqueness; independent key backup; no plaintext | Model, encryption, import, key-rotation tests |
| `src/models/BankTransaction.js` | Unique `{provider, providerTransactionId}`; processing states; claim token fields **unused** in bank path; matchedTenancyId; rawPayload | storeAndReconcile, webhook, reconciliation, transaction.service, integrityVerifier | Payment.bankTransactionId | Keep processing machine; **reuse** claim fields for concurrent process workers if needed; consider identity extension `{provider, bankAccountId, providerTransactionId}` if uniqueness scope requires it | **EXTEND** (index policy **BLOCKED BY VERIFICATION** on TransactionId scope) | Idempotency; shared ingestion | Index change needs duplicate preflight | reconciliation, webhook |
| `src/models/Payment.js` | origin BANK; sparse unique bankTransactionId | accountingPosting, reconciliation | BankTransaction, G3 | **PRESERVE** G3 link | **PRESERVE** | Sole financial authority | None | g3 + reconciliation |

### 4.2 Provider registry and adapters

| Source path | Current behaviour | Callers | G4 destination | Class | Notes |
|-------------|-------------------|---------|----------------|-------|-------|
| `bank.factory.js` | Registry flags; cache key = provider name; only COOP constructed | bank.service, webhook, tests | Provider-neutral registry remains; **cache/auth context must be connection-scoped** (or per credential reference), not process-global singleton | **REFACTOR** | Tests in `bankRegistry.test.js` must be updated for connection-scoped resolution |
| `bank.interface.js` | Generic methods | CoopBankProvider | **PRESERVE** contract; optional entitlement-aware methods | **EXTEND** lightly | Keep provider-specific verify/normalize inside adapter |
| `providers/coop/*` | Env credentials; password grant; Basic webhook secret; polled schema labeled unverified | factory | Inject connection credential resolver; no env fallback for customer traffic; gate unverified capabilities | **REFACTOR** | **BLOCKED BY VERIFICATION** for scopes, TTL, polled schema, INS auth strength |
| `validators.js` provider enum | Allows KCB/EQUITY/NCBA in connect schema | bank routes | Connect API must reject unimplemented providers even if enum lists them | **EXTEND** | Align with registry `implemented` |

### 4.3 Credentials and tokens

| Source path | Current behaviour | G4 destination | Class |
|-------------|-------------------|----------------|-------|
| `environment.js` `COOP_*` | Global optional env | Platform bootstrap / single-tenant ops only — **not** customer credential store; customer credentials are resolved through owner-scoped MongoDB `BankCredential` records | **MIGRATE** usage pattern |
| `coop.auth.js` instance fields `_token`, `_expiresAt` | Process-memory cache on singleton provider | Per-connection (or per credential ref) token isolation; no cross-connection reuse | **REFACTOR** |
| `encryption.js` | Account number encrypt + HMAC | **PRESERVE** for account numbers; separate AES-256-GCM `BankCredential` envelope and encryption key for API credentials | **PRESERVE** + **ADD** credential encryption storage |

### 4.4 Ingestion, idempotency, sync

| Source path | Current behaviour | G4 destination | Class |
|-------------|-------------------|----------------|-------|
| `bank.service.js` `storeAndReconcile` | Loop: withIdempotency by **providerTransactionId only** → reconcile; advances caller’s lastSyncedAt after full method | Shared ingestion module used by poll **and** webhook; checkpoint advances only past **accepted** persists; report reconcile failures | **REFACTOR** |
| `utils/idempotency.js` | findOne by single field; create; catch 11000 | Align key with **actual unique index** (include provider and/or bankAccountId as required) | **REFACTOR** |
| Unique index `{provider, providerTransactionId}` | Enforced at Mongo | Keep until TransactionId scope verified; **PROPOSED** safe extension includes `bankAccountId` if IDs are per-account | Index policy **BLOCKED BY VERIFICATION** |
| `bank.service.js` `sync` | Batch 100; always sets lastSyncedAt after return | Durable checkpoint on account; optional lock; do not claim full success if reconcile failures | **EXTEND** |
| `bankSync.job.js` | All connected accounts sequentially | Reuse job; respect locks/checkpoints; connection must be active | **EXTEND** |
| `webhook.routes.js` | Co-op-specific; duplicates persist loop | Thin provider webhook → shared ingestion; path may stay Co-op-prefixed but pipeline shared | **REFACTOR** |
| `processingClaimToken` on BankTransaction | Schema only; **no writers** in bank path | **PRESERVE** fields; wire for concurrent claim if workers race | **EXTEND** when implementing concurrent processors |

### 4.5 Connect / validation / ownership

| Source path | Current behaviour | G4 destination | Class |
|-------------|-------------------|----------------|-------|
| `connectAccount` validation catch | Logs warning and **still sets connected** | **MUST fail closed** — validation failure/unavailable → not `connected` | **REFACTOR** (implements established decision) |
| Unique `{provider, accountNumberHash}` | One row per provider+account number globally | Physical identity of an account number under a provider remains unique; reconnect **updates** existing BankAccount (link to connection, re-validate) rather than inserting a second row | **PRESERVE** uniqueness; **EXTEND** reconnect semantics |
| Webhook lookup | `provider + connected + accountNumberHash` | Same lookup; also require parent connection active / authorized for entitlements used | **EXTEND** |
| Estate/client auth | clientId on create; estateFilter on list/get/sync | **PRESERVE** | **PRESERVE** |

### 4.6 G3 finance

| Source path | Current behaviour | G4 destination | Class |
|-------------|-------------------|----------------|-------|
| `reconciliation.service.js` | Tenancy-aware match; posts via accounting path | **PRESERVE** sole authority | **PRESERVE** |
| `accountingPosting.service.js` | Tenancy required; allocationRev CAS | **PRESERVE** | **PRESERVE** |

### 4.7 API surface

| Source path | Current behaviour | G4 destination | Class |
|-------------|-------------------|----------------|-------|
| `bank.routes.js` / controller | accounts CRUD-ish: connect, list, sync, statement | Add connection resources; account link requires connectionId; no secrets in responses | **EXTEND** |
| `webhook.routes.js` | `/banks/coop/transactions` | Keep Co-op route; shared pipeline | **REFACTOR** internals |
| Report bank-transactions | Read model | **PRESERVE** with connection/account filters as needed | **EXTEND** filters |

---

## 5. Provider identifiers (resolved from source)

| Question | Answer from source |
|----------|-------------------|
| Which provider identifier strings exist? | **`COOP`, `KCB`, `EQUITY`, `NCBA`** in BankAccount enum, validators, factory registry |
| Stored DB values? | Same string literals on `BankAccount.provider` and `BankTransaction.provider` |
| Must values change for G4? | **No rename required** for Co-op. Keep `COOP`. Unimplemented names may remain in enum for forward compatibility but **MUST NOT** be connectable |
| Callers depending on literals | factory switch/`implemented`, webhook hardcodes `'COOP'`, mapper sets `provider: 'COOP'`, validators enum, tests |
| Platform list | `platform.service.js` exposes COOP name — must remain truthful (`implemented`) |

---

## 6. Reconnect and BankAccount identity (resolved from source)

**VERIFIED:** Unique index `{ provider: 1, accountNumberHash: 1 }` means at most one BankAccount document per (provider, account number) in the entire database.

**Implications for G4:**

- “Multiple connections per client/provider” does **not** mean multiple BankAccount rows for the same account number under COOP.
- Reconnecting the same physical account **must** locate the existing row by provider+hash (or explicit id) and **update** `connectionId`, credentials linkage, status, entitlements — not insert a duplicate.
- Historical `BankTransaction.bankAccountId` remains stable if `_id` is preserved on reconnect-in-place (**PROPOSED** required behaviour).
- Moving an account number to another estate/client is an explicit audited relink (unique index still holds globally — only one owner row can exist).

---

## 7. Idempotency helper vs unique indexes (resolved from source)

**VERIFIED:**

- Mongo unique index: `{ provider: 1, providerTransactionId: 1 }`.
- `withIdempotency` in both `bank.service.js` and `webhook.routes.js` uses keyField **`providerTransactionId` only** (no provider predicate on findOne).

**Consequences:**

1. Pre-insert findOne can return a document from another provider if IDs collided across providers (unlikely if IDs are opaque, but the query is weaker than the index).
2. Duplicate key 11000 still protects the compound unique index on concurrent creates.
3. Helper does **not** include `bankAccountId`; two accounts cannot legally share the same `(provider, providerTransactionId)` under the current index.

**G4 action:** Refactor shared ingestion to query/create with the **same** key shape as the unique index (and any extended index after verification). Treat current single-field helper usage as a **defect relative to the index**, not as the target design.

---

## 8. Synchronization and processing mechanisms to reuse

| Mechanism | Reuse? | Notes |
|-----------|--------|-------|
| `withIdempotency` pattern | Yes, after key alignment | Shared by poll + webhook |
| `processingState` machine | Yes | RECEIVED → … → POSTED / FAILED_* / MANUAL_REVIEW |
| `processingClaimToken` / expires | Yes (currently dormant) | Suitable for concurrent claim of FAILED_RETRYABLE work |
| Scheduler distributed lock | Yes for job-level | Not a per-account sync lock today |
| `lastSyncedAt` | Insufficient alone | Replace/supplement with durable checkpoint metadata |
| `reconciliationService.reconcile` | **Mandatory reuse** | Do not fork finance |
| Webhook rate limiter | Preserve | |
| `sanitizeBankAccount` / toJSON strip | Preserve | |

---

## 9. Challenge: contradictions and risks

| # | Issue | Severity | Correction |
|---|--------|----------|------------|
| 1 | Validation failure still activates `connected` | Critical vs established decision | Fail closed in connect/reauth |
| 2 | Global env credentials + singleton provider | Critical vs connection-scoped secrets | Connection credential refs + no customer global fallback |
| 3 | Webhook and sync duplicate ingestion logic | High | One shared module |
| 4 | Idempotency find key ≠ unique index shape | High | Align keys |
| 5 | `lastSyncedAt` advanced after partial reconcile failures | High | Checkpoint + explicit result |
| 6 | Unique account hash vs “multiple connections” misread as multiple rows | High | Document reconnect-in-place; one row per provider+number |
| 7 | Co-op-specific imports in webhook route | Medium | Adapter verify/normalize only; shared persist |
| 8 | Enum allows unimplemented providers on connect | Medium | Enforce registry at service layer |
| 9 | Claim fields unused under concurrent webhook+sync | Medium | Optional claim before reconcile |
| 10 | Polled mapper schema unverified | High (data) | Gate or complete only with evidence |
| 11 | Tests assume `getBankProvider('COOP')` singleton | Medium | Update when factory becomes connection-aware |
| 12 | No account-level entitlements in schema | Medium | Add representation per established decision |

### Unsafe migrations to avoid

- Dropping `{provider, accountNumberHash}` unique without replacement.
- Changing `{provider, providerTransactionId}` unique without preflight for duplicates.
- Deleting BankAccount rows on disconnect (would orphan or break transaction references) — prefer status + connection inactive.
- Rewriting historical `clientId`/`estateId` on BankTransaction on relink.

---

## 10. BLOCKED BY VERIFICATION (bank evidence)

Do **not** invent:

- Co-op TransactionId uniqueness scope (global vs per-account).
- OAuth scope strings, token TTL, refresh behaviour for production apps.
- Full AccountTransactions item schema for polling.
- INS authentication beyond current Basic shared-secret behaviour.
- Whether password-grant username/password is an integration principal issued by the portal (acceptable as connection secret material when encrypted in the owner-scoped BankCredential store) versus a retail internet banking login (prohibited in product UX).

---

## 11. Proposed corrections to G4 architecture (documentation-level)

These corrections align the target architecture with **source reality** and **established decisions** without reopening those decisions:

1. **BankAccount identity:** Explicitly state that provider + accountNumberHash remains the global unique physical identity; multiple connections do not create duplicate account rows for the same number.
2. **Reconnect:** Specify update-in-place of BankAccount (`connectionId`, validation, entitlements), preserving `_id` for transaction history.
3. **Shared ingestion:** Mandate one module; webhook becomes a thin adapter entrypoint (remove duplicated persist loop).
4. **Idempotency:** Mandate key parity with the unique index; document the current single-field helper as a source defect to fix.
5. **Validation:** Connect/reauth paths fail closed (source today is non-compliant).
6. **Credentials:** Connection stores `credentialsRef` and `credentialVersion`; the referenced `BankCredential` holds only the AES-256-GCM encrypted envelope. Remove customer path dependence on `COOP_*` env.
7. **Factory:** Connection-scoped auth context; registry stays provider-neutral.
8. **Entitlements:** Account-level (and/or connection-level) capability flags stored and checked before poll/webhook processing.
9. **Checkpoints:** Embed on BankAccount (or connection+account); do not treat `lastSyncedAt` as sufficient.
10. **G3:** Unchanged sole financial authority — crosswalk confirms call path already correct.

---

### 4.3 Credential migration target and source compatibility

The previous Redis credential envelope is `tycoon-bank-secret` v1, AES-256-GCM, with AAD `tycoon-bank-secret:1:<credentialsRef>` and key ID derived from SHA-256 of the raw key. Legacy records contain `material`, `credentialVersion` (historically nullable), and `updatedAt`. The migration reader rejects missing/null versions rather than inferring them.

The migration source is the set of persisted `BankConnection.credentialsRef` values, not a Redis key scan. All connection lifecycle states are included because disconnect retains credentials. Unreferenced Redis keys are out of scope. Imports preserve each existing reference and version and use create-only `BankCredential` writes with read-back verification. Redis values are not deleted by this process.

Legacy source keys MUST be explicitly supplied using `LEGACY_BANK_SECRETS_ENCRYPTION_KEY` and optional `LEGACY_BANK_SECRETS_ENCRYPTION_KEY_PREVIOUS`. Destination keys use `BANK_SECRETS_ENCRYPTION_KEY` and optional `BANK_SECRETS_ENCRYPTION_KEY_PREVIOUS`; the two keyrings MUST be distinct. Redis access uses a dedicated `LEGACY_REDIS_URL` connection and a GET-only reader interface, not the application Redis singleton. The GET-only wrapper is not equivalent to a server-side read-only ACL.

## 12. Source coverage summary

**Inspected and traced:** models (BankAccount, BankTransaction, Payment, and G3 touchpoints), banking factory/interface/coop adapter set, bank.service, reconciliation, accountingPosting, transaction.service, integrityVerifier, platform provider listing, bank controller/routes, webhook routes, report route, bankSync job, scheduler references, environment COOP vars, encryption, idempotency, validators, estateFilter, ensureIndexes, unit and integration tests listed above.

**Not required for this crosswalk:** frontend repository, production database contents, live Co-op sandbox calls.

---

## 13. Remaining technical blockers

| ID | Blocker | Blocks |
|----|---------|--------|
| TX-ID-SCOPE | Official uniqueness of provider transaction ids | Final unique index shape |
| COOP-AUTH-CONTRACT | Portal-verified grant/scope/TTL/refresh | Production credential runtime |
| COOP-POLL-SCHEMA | Verified polled item fields | Safe polling mapper completion |
| COOP-INS-AUTH | Verified webhook authentication mechanism | Production webhook hardening |
| LEGACY-REDIS-KEY-CUSTODY | Recoverable legacy current/previous Redis encryption keys, distinct from the new Mongo destination key | Credential migration preflight and execute |
| LEGACY-REDIS-ACCESS | Dedicated source Redis endpoint, secure network path and documented authentication/access constraints | Credential migration preflight and execute |
| CREDENTIAL-MIGRATION-RECOVERY | Independent Mongo backup, destination key backup and tested restore procedure | Credential migration execute and production readiness |
| CREDENTIAL-INVENTORY-STABILITY | Quiesced connection create/reauthorize operations or verified inventory fingerprinting during migration | Consistent reference/version import |

---

## 14. Finish state

- The source crosswalk records the original backend snapshot; its original source-behaviour findings remain distinct from the implemented G4 target.
- The earlier external-secrets-manager target is superseded by the MongoDB `BankCredential` encrypted-envelope architecture.
- `BankConnection.credentialsRef` remains the stable reference and is preserved during legacy Redis import.
- Candidate implementation includes the Mongo credential model, AES-256-GCM service, key rewrapping, legacy Redis GET reader and create-only import path.
- Runtime unit suite passed: 36 suites / 212 tests.
- Candidate unit suite passed: 21 suites / 163 tests.
- Candidate full no-database suite passed: 22 suites passed, 1 suite skipped; 164 tests passed and 24 database-dependent tests skipped.
- Destructive MongoDB integration tests and live Redis migration have **not** been run.
- Original repository remained clean during this work; no original application source was modified.
- Live migration remains blocked on legacy key custody, secure source access, independent backup/restore evidence and inventory-stability controls.

## G4 runtime verification addendum (2026-11-12)

The earlier crosswalk rows document the original source baseline and planned transformations. The following target-runtime behavior has since been implemented and tested:

| Area | Current target behavior |
|---|---|
| Provider factory | `implemented` and `operationalReady` are distinct. COOP is implemented but not operationally ready. |
| Connection creation | COOP lab exception requires `COOP_BANK_LAB_MODE=1` and non-production `NODE_ENV`. |
| Account linking | Uses the same non-production COOP lab gate; provider account validation remains mandatory. |
| FullStatement sync | `statement` entitlement is sufficient for the registered COOP FullStatement strategy; entitlement is revalidated during sync. |
| AccountTransactions polling | Remains disabled because its item schema is not verified. |
| Webhook | Requires webhook readiness or explicit non-production `COOP_WEBHOOK_LAB_OVERRIDE=1`. |
| INS Basic credential | Remains application-level according to current contract evidence; no unsupported per-connection contract is assumed. |
| Checkpoints and concurrency | Failed required ingestion blocks checkpoint advancement; real replica-set tests cover unique transaction identity, claim races and fencing. |

See the dated verification refresh in `docs/G4_FINAL_IMPLEMENTATION_REVIEW.md` for test scope and remaining limitations.
