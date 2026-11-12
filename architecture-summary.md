# G4 Architecture Summary: Agent Context and Execution Rules

**Status:** Architecture locked for implementation. Documentation is the implementation contract.  
**Repository:** `jolla3/tycoon-estates-backend`  
**Verified GitHub `main` HEAD (rechecked):** `e0b49c2f122be7ae3ed14eaba9eecfeacee7ce13` (`v2.0.3`, 2026-11-10 20:14:31 +0300)  
**Workspace baseline:** Matches HEAD `src/`, `tests/`, `scripts/`, `package.json`, `package-lock.json` (diff clean).  
**Historical G3 reference:** `1c93f0ed71ca45620ddc238f98fd6391b5a1f054` (`v2.0.1`)  
**Full requirements:** `PRD.md`  
**Detailed design:** `architecture.md`  
**Source crosswalk:** `SOURCE_CROSSWALK.md`

## 1. Product and scope

G4 builds a **provider-neutral, multi-client** bank integration foundation:

- `BankConnection` owns connection identity, credential **references**, auth lifecycle, and connection health.
- `BankAccount` owns physical account identity, client/estate association, and current connection link.
- Co-op is the first operational adapter only.
- Polling and webhooks share one normalized ingestion path into **existing G3** reconciliation and `accountingPosting`.

**NON-GOAL:** G5 Daraja/M-PESA. **NON-GOAL:** second Ledger/Payment engine. **NON-GOAL:** implementing KCB/EQUITY/NCBA in G4.

## 2. GitHub is the source of truth — mandatory

1. Fetch latest GitHub `main` before every implementation session; record HEAD SHA.
2. Diff against this document’s verified SHA; re-read changed banking/G3 callers.
3. Never destructive-reset local work to force-match GitHub.
4. If HEAD advances, stop and report impact before coding on a stale baseline.

## 3. Verified current source snapshot (`e0b49c2`)

| Fact | Path |
|------|------|
| No BankConnection model | — |
| BankAccount unique `{provider, accountNumberHash}` | `src/models/BankAccount.js` |
| BankTransaction unique `{provider, providerTransactionId}` | `src/models/BankTransaction.js` |
| Global `COOP_*` env credentials; in-process token on provider singleton | `environment.js`, `coop.auth.js`, `bank.factory.js` |
| Validation failure can still set `connected` | `bank.service.js` `connectAccount` |
| `withIdempotency` keys on `providerTransactionId` only (weaker than unique index) | `idempotency.js`, callers |
| Webhook and sync duplicate persist+reconcile loops | `webhook.routes.js`, `bank.service.js` |
| `lastSyncedAt` only; claim fields on BankTransaction unused | models + bank path |
| G3 tenancy posting via reconciliation → accountingPosting | **PRESERVE** |

## 4. Locked architecture invariants (do not reopen)

### Connection and ownership
- One BankConnection → exactly one client + one provider.
- Multiple independent connections per client/provider **are supported**.
- One connection may authorize multiple BankAccounts.
- One BankAccount = one physical bank account; **cannot** be registered to two Tycoon clients at once.
- Global unique physical identity remains `{provider, accountNumberHash}` unless a separately approved migration says otherwise.
- Same-client reconnect of the same physical account **reuses** the existing BankAccount `_id`.
- Estate reassignment is explicit and audited; historical transactions keep original ownership context.
- Cross-client transfer is **not** ordinary reconnect and is **not** authorized by G4.

### Account activation and direction
- Failed or unavailable account validation **cannot** activate an account.
- Transaction direction must be explicit and validated; never default unknown direction to `CREDIT`.

### Credentials and authorization
- Customer bank API credentials are **connection-scoped**.
- **No** customer-specific global env credential fallback.
- Store customer credentials as AES-256-GCM encrypted envelopes in MongoDB `BankCredential`; `BankConnection.credentialsRef` equals `BankCredential._id`, with owner/provider/version binding. Never store plaintext.
- Redis is temporary infrastructure only, never credential storage or a plaintext credential cache.
- Legacy Redis migration uses exact-reference `GET`, separate `LEGACY_*` source keys, create-only Mongo import, exact version matching and read-back verification. No automatic Redis deletion.
- Token state isolated by connection **and credential version**.
- Provider instances **must not** share customer auth state via a provider-name singleton.

### Providers
- Identifiers preserved: `COOP`, `KCB`, `EQUITY`, `NCBA`.
- Only COOP implemented in G4; do not advertise others as operational.
- Provider-specific behaviour stays inside adapters.

### Transactions and G3
- One shared ingestion pipeline for poll + webhook.
- Transaction **direction must be explicit and validated**; never default unknown direction to `CREDIT`.
- Preserve current transaction unique index until provider ID guarantees justify change.
- Idempotency lookup **must match** the unique index key shape.
- G3 reconciliation + accountingPosting = sole financial authority.

### Synchronization
- Checkpoints advance only after retrieved transactions are **durably accepted**.
- Reconciliation failure remains observable/retryable independent of ingestion durability.
- Scheduled and manual sync share account-level coordination.
- Fencing / conditional writes prevent stale workers from overwriting newer checkpoints.

### Provider verification
- Do not invent Co-op auth, token TTL, transaction-ID guarantees, poll schemas, callback signatures, or retries.
- Unverified contracts stay **BLOCKED BY VERIFICATION**.
- Do not invent cryptographic signature schemes the provider does not document.

## 5. Engineering agent execution constraints

- Read PRD, architecture, this summary, and SOURCE_CROSSWALK before coding.
- Recheck GitHub HEAD; record SHA.
- Change application code only inside `g4/` until a merge strategy is approved.
- No model/index/endpoint/dependency without a requirement ID.
- No parallel finance engine.
- Versioned migrations with dry-run/preflight only.
- Report actual test commands and outcomes; mark NOT RUN / SKIPPED honestly.

## 6. Mandatory delivery order

1. Models, indexes, safe migrations  
2. Connection-scoped credentials / auth isolation  
3. Provider registry / adapter contract  
4. Co-op adapter (verified contracts only)  
5. Shared ingestion / idempotency  
6. Account-scoped sync, checkpoints, recovery  
7. Webhook through shared pipeline  
8. G3 reconciliation regression  
9. API contract / frontend boundary  
10. Monitoring / production readiness  

G3 regression applies in every phase that touches financial or bank persistence paths.

## 7. Rejected over-engineering

DB-managed provider catalog · automatic BankSyncRun collections without evidence · second ledger · invented webhook crypto · exposing unimplemented banks · retail banking login as API credentials · frontend repo assumptions inside this backend.

## 8. Completion rule

Documentation lock ≠ implementation complete. Each phase needs exit evidence. G4 is complete only when phases 1–10 meet acceptance criteria with real tests and verification gates closed or explicitly waived by the owner.

## Current provider gates and verified G4 behavior

- COOP adapter code is implemented, but overall provider `operationalReady` remains false. KCB/EQUITY/NCBA remain disabled. No provider is currently production-operational.
- `COOP_BANK_LAB_MODE=1` permits COOP connection creation, account linking and FullStatement sync only outside production. It does not alter readiness.
- `COOP_WEBHOOK_LAB_OVERRIDE=1` permits controlled webhook lab exposure only outside production. Production overrides are rejected.
- COOP FullStatement sync accepts `statement` entitlement; the unverified AccountTransactions polling path remains disabled. Entitlements are checked again during the run.
- Inbound INS Basic remains platform/application-level according to current contract evidence, not per-connection.
- Local regression, HTTP integration and Mongo concurrency evidence is recorded in the final implementation review. None of it substitutes for provider sandbox verification.
