# G4 Technical Architecture: Bank Connections and Co-op Integration

**Status:** Architecture locked for implementation.  
**Repository:** `jolla3/tycoon-estates-backend`  
**Verified GitHub `main` HEAD:** `e0b49c2f122be7ae3ed14eaba9eecfeacee7ce13` (`v2.0.3`)  
**Workspace baseline:** Diff-clean vs HEAD for `src/`, `tests/`, `scripts/`, package files.  
**Requirements:** `PRD.md` · **Agent constraints:** `architecture-summary.md` · **Crosswalk:** `SOURCE_CROSSWALK.md`

## 1. Architecture objective and boundary

G4 introduces a connection-scoped, provider-neutral bank integration layer while retaining the G3 tenancy-aware accounting engine. Responsibilities:

1. **Connection management** — client ownership, credential **references**, auth lifecycle, health.  
2. **Bank-account mapping** — physical account identity, client/estate association, current connection.  
3. **Provider transport** — adapter-local auth, requests, schema validation, webhook verification, mapping, capability declaration.  
4. **Shared ingestion + finance hand-off** — normalize, ownership validate, durable idempotent persist, recoverable process, G3 reconciliation/accountingPosting only.

MUST NOT introduce a second payment or ledger engine. Co-op is the only G4 adapter. Daraja/M-PESA is G5.

## 2. Source baseline (VERIFIED at e0b49c2; recheck before coding)

| Path | Observation | G4 treatment |
|------|-------------|--------------|
| `src/models/BankAccount.js` | client/estate/provider; encrypt+hash; unique `{provider, accountNumberHash}`; connectionStatus; lastSyncedAt | EXTEND: connectionId, sync checkpoint/lock, entitlements; fail-closed activation |
| `src/models/BankTransaction.js` | unique `{provider, providerTransactionId}`; processingState + unused claim fields; matchedTenancyId | EXTEND carefully; PRESERVE unique index until evidence |
| `src/services/banking/bank.factory.js` | COOP implemented; singleton by provider name | REFACTOR: connection-scoped auth context |
| `src/services/banking/providers/coop/*` | Env credentials; password grant; Basic webhook secret; polled schema unverified | REFACTOR injection; gate unverified paths |
| `src/services/bank.service.js` | storeAndReconcile; connect may ignore validation failure; lastSyncedAt after return | REFACTOR orchestration; fail closed; checkpoints |
| `src/routes/webhook.routes.js` | Co-op-specific; duplicates persist loop | REFACTOR to shared pipeline |
| `src/utils/idempotency.js` | Single-field key | REFACTOR to match unique index |
| `src/services/reconciliation.service.js` + `accountingPosting.service.js` | G3 authority | **PRESERVE** |
| BankConnection | Absent | **ADD** |

### 2.1 Source defects the architecture closes

1. Global env + provider-name singleton token cache.  
2. Validation failure still activates `connected`.  
3. Idempotency find key weaker than unique index.  
4. Duplicated webhook/sync ingestion.  
5. `lastSyncedAt` is not a durable accepted-work checkpoint.  
6. No connection or entitlements model.  
7. Unimplemented providers allowed by validator enum at API edge.

## 3. Target domain model

### 3.1 BankConnection — ADD

```
BankConnection {
  clientId: ObjectId (required, indexed)
  provider: 'COOP' | 'KCB' | 'EQUITY' | 'NCBA' (required)
  displayName?: string
  status: pending | active | reauth_required | disconnected | failed
  // MongoDB BankCredential reference — NOT the secret material itself
  credentialsRef: string (required)          // equals BankCredential._id
  credentialVersion: number (required)     // monotonic; bumps on rotate
  authMeta: {
    tokenExpiresAt?, lastAuthAt?, lastAuthError?, externalClientId?
  }
  createdByUserId?, updatedByUserId?
  timestamps
}
```

**Indexes (PROPOSED):** `{ clientId: 1, provider: 1, status: 1 }`.  
Multiple active connections per client+provider are **allowed**.

### 3.2 BankAccount — EXTEND

**PRESERVE:** `clientId`, `estateId`, `provider`, encrypted account number, `accountNumberHash`, currency, accountName, timestamps, unique `{provider, accountNumberHash}`.

**ADD:**

- `connectionId` (required for new G4-managed rows; indexed)
- `entitlements` (explicit capability flags the account is authorized to use — e.g. poll, statement, webhook ingest)
- Sync metadata (embedded preferred):

```
sync: {
  lastAttemptAt?, lastSuccessAt?, lastError?,
  checkpoint: { type, value, acceptedThrough? },
  lockOwner?, lockExpiresAt?, fenceToken?
}
```

**Status policy (LOCKED):**  
`connectionStatus` (or successor activation field) MUST NOT become activated/`connected` when account validation fails or is unavailable.

**Identity (LOCKED):**  
Physical uniqueness remains global `{provider, accountNumberHash}`. Same-client reconnect **updates** the existing document and **preserves `_id`**. Cross-client transfer is out of scope.

**INVARIANT:** `BankAccount.clientId` equals `BankConnection.clientId`; providers match; `connectionId` references that connection.

### 3.3 BankTransaction — EXTEND carefully

**PRESERVE:** processingState machine (`RECEIVED`, `CLAIMED`, `POSTED`, `FAILED_RETRYABLE`, `FAILED_TERMINAL`, `MANUAL_REVIEW`), match fields, rawPayload storage policy (no secrets in payload), unique `{provider, providerTransactionId}`.

**Direction (LOCKED):** Event direction MUST be explicit and validated at normalization. Unknown or ambiguous direction MUST be rejected — **never** defaulted to `CREDIT`.

**Claim fields:** PRESERVE `processingClaimToken` / `processingClaimExpiresAt`; wire when concurrent processors need them.

**Optional denormalized `connectionId`:** MAY store for ops queries; not required for G3 posting.

### 3.4 Synchronization state

Start **embedded** on BankAccount.sync. Do **not** add BankSyncState/BankSyncRun collections unless verified multi-stream or durable run-history requirements appear and are approved.

**Checkpoint rules (LOCKED):**

1. Represents highest **durably accepted** position.  
2. Advance only after successful idempotent persistence of accepted items.  
3. Reconcile failure after persist → leave transaction retryable; report failures; do not claim “all posted.”  
4. Do not advance checkpoint if the page/batch durable write failed.  
5. Overlap polls rely on idempotent persistence.  
6. Account-level lock with expiry; fencing/conditional writes so stale workers cannot overwrite newer checkpoint state.  
7. Manual and scheduled sync share the same coordination path.

## 4. Credentials, encryption, and tokens

### 4.1 Durable credential storage (LOCKED)

- `BankConnection.credentialsRef` is an opaque reference equal to `BankCredential._id`.
- `BankCredential` is stored in MongoDB collection `bankcredentials`, separate from `BankConnection`.
- Each record binds `credentialsRef`, `clientId`, `provider`, and `credentialVersion` to an encrypted envelope.
- The envelope uses AES-256-GCM with a 12-byte random IV, a 16-byte authentication tag, and a key identifier.
- Authenticated associated data binds the envelope to its format/version, credential reference, client, provider, and credential version. Copying ciphertext to another identity MUST fail authenticated decryption.
- The destination key is supplied as `BANK_SECRETS_ENCRYPTION_KEY` (32 bytes represented as 64 hexadecimal characters). `BANK_SECRETS_ENCRYPTION_KEY_PREVIOUS` is read-only compatibility for controlled key rewrapping.
- The destination key MUST be backed up independently of MongoDB and MUST NOT be stored in MongoDB, Redis, source control, or ordinary application logs.
- Plaintext credential material MUST exist only in the process memory required to authenticate the provider. It MUST NOT be persisted or cached in Redis.
- `BankCredential` API serialization MUST NOT expose its `_id` or encrypted envelope. A serialization transform is defense in depth, not a substitute for access control.

### 4.2 Credential classes

1. **Platform secrets** (`ENCRYPTION_KEY`, session secrets) — process environment.
2. **Customer connection credentials** — encrypted MongoDB `BankCredential` records; `BankConnection` stores the matching reference and credential version.
3. **Legacy migration-only secrets** — the previous Redis encryption keys and legacy Redis URL supplied separately as `LEGACY_BANK_SECRETS_ENCRYPTION_KEY`, `LEGACY_BANK_SECRETS_ENCRYPTION_KEY_PREVIOUS`, and `LEGACY_REDIS_URL`. These are source-decryption inputs only, not destination keys.
4. **Prohibited in product UX:** retail online/mobile banking password, PIN, OTP, card numbers.

The old Redis implementation used `BANK_SECRETS_ENCRYPTION_KEY` and its `_PREVIOUS` counterpart for the legacy Redis envelope. During migration, operators MUST supply those old values through the distinct `LEGACY_*` names and configure a separate destination `BANK_SECRETS_ENCRYPTION_KEY`. The migration MUST NOT silently reuse, infer, or alias source and destination keys. Source and destination keyrings MUST be validated as distinct.

Global `COOP_*` env may remain for **platform bootstrap / non-customer** tooling only. Customer traffic MUST NOT fall back to global env credentials.

Redis is non-authoritative temporary infrastructure for locks, rate limits, metrics and loss-tolerant cache state only. It MUST NOT store new customer credentials or decrypted credential material. The migration reader accepts only an injected Redis dependency exposing `GET`; it MUST NOT import or initialize the application's general-purpose Redis singleton. This code-level restriction is not a server-side Redis ACL.

### 4.3 Account numbers

**PRESERVE** `encryptionUtil` AES-256-GCM + HMAC `hashForLookup` for account numbers. This remains separate from the `BankCredential` key and envelope.

### 4.4 Token isolation (LOCKED)

- Cache key includes BankConnection identity **and** `credentialVersion`.
- Credential rotation invalidates only that connection’s token state.
- Two COOP connections MUST NOT share access/refresh token state.
- `getBankProvider(providerName)` singleton cache is **insufficient**; use connection-scoped auth context or pass explicit connection context into adapter operations.
- Never log token or secret material.

## 5. Provider registry and adapter contract

**PRESERVE** `bank.interface.js` shape.

Registry remains in-code (not a DB catalog). Expose `implemented` and capability flags only when verified. Client-facing list filters to implemented + configured.

Unimplemented providers: fail closed at connect.

## 6. Shared transaction ingestion pipeline

```
provider raw
  → adapter.verify (webhook only)
  → adapter.normalize (direction required; reject unknown)
  → ownership validate (client, estate, account, connection active, entitlements)
  → idempotent BankTransaction persistence (key = unique index shape)
  → process CREDIT via reconciliationService → accountingPosting (G3)
```

Polling skips webhook verify but uses the same normalize → validate → persist → process stages.

**Idempotency (LOCKED):** Lookup and create keys MUST match the unique index (`provider` + `providerTransactionId` today). Fix the current single-field `withIdempotency` usage.

**Index change:** BLOCKED BY VERIFICATION on TransactionId scope. Any change requires duplicate preflight migration.

## 7. Co-op adapter

### 7.1 Implemented surface in source (transport only)

AccountTransactions, AccountFullStatement, AccountBalance, AccountValidation, SendTransactionINS inbound.

### 7.2 BLOCKED BY VERIFICATION

Grant parameters, scope strings, token TTL/refresh, polled item schema, TransactionId uniqueness scope, INS authentication beyond Basic shared-secret equality, callback subscription/retry guarantees, pagination ordering guarantees.

Do not invent cryptographic webhook signatures. Document transitional Basic shared-secret control as limited until official contract says otherwise.

### 7.3 Operational gating

Until gates pass, keep corresponding live capabilities disabled or explicitly “not provisioned” in API health.

## 8. Synchronization architecture

- Account-level coordination for job + manual sync.  
- Reuse scheduler distributed lock for job-level multi-instance safety; add per-account sync lock/fence for checkpoint integrity.  
- Partial failure reporting in API/metrics.  
- `bankSync.job.js` continues iterating eligible accounts but must respect connection active + account activated + entitlements + locks.

## 9. G3 financial invariants (PRESERVE)

- Tenancy is the financial ownership boundary.  
- Allocations cannot cross tenancies.  
- MongoDB transactions required for multi-document financial writes; fail closed without them.  
- PaymentAllocation rows authoritative for allocation totals.  
- Bank path creates at most one Payment per BankTransaction via existing reconciliation logic.  
- DEBIT events are not auto-posted as rent payments.  
- Ambiguous matches → UNMATCHED / MANUAL_REVIEW, never guess current house tenant.

## 10. API contract (backend)

Illustrative surface (names may follow existing `/bank` prefix conventions):

- Connection CRUD-ish: create, list, get, reauthorize, disconnect (no secret material in responses).  
- Account link/list/get; sync; statement import.  
- Webhook: provider-specific path (e.g. `/banks/coop/transactions`) → shared pipeline.  
- Reports: bank transactions with estateFilter.

All authenticated routes PRESERVE session auth, clientContext, authorize roles, estateFilter.

Frontend repository is external; OpenAPI updated in phase 9.

## 11. Migration and rollout

### 11.1 General

- Versioned scripts under `scripts/migrations/`.  
- Dry-run/preflight by default; execute only on allowlisted disposable or explicitly approved DBs.  
- Never drop identity indexes on application startup.

### 11.2 Phase 1 expectations

1. Add BankConnection collection.  
2. Add BankAccount.connectionId (nullable during migration window), sync metadata, entitlements fields.  
3. Document reconnect-in-place rules; do not break `{provider, accountNumberHash}` uniqueness.  
4. Backfill strategy for existing BankAccounts: explicit migration design (synthetic connection per client from platform bootstrap refs vs require reconnect) — implement only with clear, tested mapping; do not invent ownership from provider name alone.  
5. No change to BankTransaction unique index in Phase 1 unless preflight proves necessity and safety.  
6. Tests for model constraints and migration preflight.

### 11.3 Credential storage and legacy Redis migration

The target credential store is MongoDB `BankCredential`; the earlier external-secrets-manager target is superseded by this decision. `BankConnection.credentialsRef` remains unchanged and resolves to `BankCredential._id`.

The one-time legacy migration MUST:

1. Use every persisted `BankConnection` with a credential reference as its inventory source, including disconnected, failed, pending and reauthentication-required connections. Do not limit inventory to active connections.
2. Read each exact `tycoon:bank:secret:<credentialsRef>` key using one Redis `GET`. Do not use `SCAN`, `KEYS`, wildcard discovery, or unreferenced Redis values as the inventory.
3. Decrypt the legacy `tycoon-bank-secret` v1 envelope using explicitly supplied legacy source key(s), with its original AAD `tycoon-bank-secret:1:<credentialsRef>`.
4. Require the decrypted legacy `credentialVersion` to be present, a valid positive integer, and exactly equal to the persisted `BankConnection.credentialVersion`. A missing or null legacy version MUST NOT be inferred from Mongo; classify it for explicit reauthorization.
5. Import through the create-only `importConnectionSecret()` operation. Preserve the existing reference, client, provider and version. Never update the `BankConnection` document, status, timestamps, account links or authentication metadata as part of migration.
6. Verify the encrypted Mongo record by owner-scoped read-back and authenticated decryption. Exact repeated imports may be reported as already present; mismatched owner/provider/version/material MUST be a conflict.
7. Classify missing Redis keys, unknown legacy keys, malformed envelopes, failed authentication tags, version mismatch, duplicate-reference conflicts and uncertain writes separately. Never fabricate credentials or silently fall back to global environment values.
8. Never delete Redis source values automatically. Do not scan or purge orphan Redis values as part of this migration. Source cleanup requires a separate approved retention and recovery decision after verified backup and restore evidence.

The runner MUST default to dry-run. Dry-run may read the Mongo inventory and exact Redis references but MUST NOT write to either store. Execute mode MUST require an explicit operator acknowledgement and exact expected destination database-name match, with no loose URI substring check or `ALLOW_PROD` override. It MUST print only redacted counts and classifications, never references, plaintext, ciphertext, key values, or connection strings.

Before execute, require a recoverable MongoDB backup and independent secure backup of the destination encryption key, plus a tested restore procedure. Pause connection creation and reauthorization for the migration window, or implement and verify an inventory-stability check so references and versions cannot change unnoticed during import. No bank-provider authentication/API calls are part of migration.

Render Free Key Value has no persistence; with an eviction policy such as `allkeys-lru`, legacy source keys may be evicted. Missing source keys are unrecoverable from Redis and require explicit customer reauthorization. Do not treat Redis as a backup or durable credential store.

## 12. Security and operations

- Redact plaintext credentials, encrypted envelopes, encryption keys, tokens, Authorization headers, and legacy Redis connection details from logs and errors.  
- rawPayload MUST NOT store webhook auth secrets.  
- Metrics: sync attempts/success, checkpoint lag, webhook accept/reject, reconcile retry depth, auth failures per connection.  
- Distinct states: provider outage, auth rejection, malformed transaction, validation failure, callback not provisioned, reconciliation failure.

## 13. Test architecture

| Area | Evidence |
|------|----------|
| Registry | Unimplemented providers not connectable |
| Credential isolation | Two connections cannot share token state; no secret serialization |
| Validation | Failed/unavailable validation never activates account |
| Identity | Same-client reconnect preserves `_id`; unique provider+hash enforced |
| Ingestion | Poll+webhook replay → one BankTransaction, one Payment max |
| Direction | Missing/unknown direction rejected |
| Idempotency | Keys match unique index; concurrent creates safe |
| Sync | Crash before accept does not skip work; fence blocks stale checkpoint write |
| G3 regression | Tenancy isolation, allocation equality, no cross-tenancy post |
| Webhook | Bad auth rejected; unknown account safe ack |

## 14. Delivery phase exit gates

1. Models/indexes/migrations — preflight + recovery plan  
2. Connection-scoped credentials — dual isolation tests  
3. Registry contract — fail closed for unimplemented  
4. Co-op adapter — only verified behaviours enabled  
5. Shared ingestion — replay tests  
6. Checkpoints/recovery — crash and fence tests  
7. Webhook shared path — same pipeline assertions  
8. G3 regression — suite green on disposable RS  
9. API/OpenAPI — contract parity; frontend external  
10. Production readiness — drills, runbooks, alerts  

## 15. Adversarial notes (locked answers)

| Question | Locked answer |
|----------|----------------|
| Need BankConnection? | Yes — credentials/auth lifecycle are not per-account alone |
| Multiple connections per client/provider? | Yes |
| Secrets in Mongo? | Yes, in a separate `BankCredential` collection as AES-256-GCM envelopes; never plaintext. Key custody is independent. |
| Fail closed validation? | Yes |
| Change transaction unique index now? | No — blocked pending provider evidence |
| Default unknown direction to CREDIT? | No — reject |
| BankSyncRun collections? | No by default |
| Queue framework? | No by default |
| Cross-client account move? | Not authorized as ordinary reconnect |

### Residual risks

- Ambiguous legacy BankAccounts without connection mapping.  
- Basic webhook secret weaker than signature-based designs.  
- Unverified polled schema.  
- Operators enabling capabilities before verification gates pass.

## 16. Document control

Aligned with `PRD.md` and `architecture-summary.md` at architecture lock. Update all three together when HEAD or verification evidence changes.

## Runtime provider readiness and lab policy (verified 2026-11-12)

This section records the effective G4 runtime policy. Earlier sections describing the original G3 implementation are historical source analysis, not the current provider authorization rules.

### Registry semantics

- `adapterPresent`: a provider module is registered.
- `implemented`: the provider adapter code path is implemented.
- `operationalReady`: the provider/capability has enough verified contract and operational evidence for customer traffic.

Current registry state:

| Provider | Adapter present | Implemented | Operational ready |
|---|---:|---:|---:|
| COOP | Yes | Yes | No |
| KCB | Yes | No | No |
| EQUITY | Yes | No | No |
| NCBA | Yes | No | No |

No provider is currently advertised as operational.

### COOP lab authorization

`COOP_BANK_LAB_MODE=1` is an explicit non-production exception used by connection creation, account linking and the COOP FullStatement sync path. It is not a readiness flag and must not be used to mark COOP operational.

The exception is rejected when `NODE_ENV=production`. Production deployments must set `NODE_ENV=production`; absence of that setting is not a valid production configuration.

The webhook has its separate `COOP_WEBHOOK_LAB_OVERRIDE=1` flag. That override is also rejected in production. Without capability readiness or the non-production override, the route remains closed.

### Synchronization entitlement semantics

COOP's supported sync strategy is the FullStatement date-window strategy. The account `statement` entitlement authorizes that strategy; `poll` is not required when `statement` is true. The AccountTransactions list-polling path remains disabled because its item schema is not verified.

The orchestration layer checks entitlement before acquiring the sync lease and revalidates it during the run. A statement entitlement must not be interpreted as authorization for an unverified list-polling strategy.

### Callback credential scope

The current contract evidence supports a platform/application-level Co-op INS Basic endpoint credential (`COOP_INS_BASIC_SECRET`). It does not establish a per-customer callback credential contract. The implementation therefore does not invent per-connection INS secrets. This remains an explicit provider-contract limitation.

### Verification boundary

Local unit, HTTP integration and Mongo concurrency results are recorded in `docs/G4_FINAL_IMPLEMENTATION_REVIEW.md`. They prove the tested local application behavior, not Co-op sandbox verification, provider certification, production key-management readiness or successful deployment migrations.
