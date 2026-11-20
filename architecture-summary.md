# G4 Architecture Summary: Agent Context and Execution Rules

**Status:** Architecture locked for implementation. Documentation is the implementation contract.  
**Repository:** `jolla3/tycoon-estates-backend`  
**Verified GitHub `main` HEAD for this audit:** `25d9969eb4f1c734f360337f0a3d64b83d465a6a` (rechecked 2026-11-20)  
**Workspace baseline:** Matches HEAD `src/`, `tests/`, `scripts/`, `package.json`, `package-lock.json` (diff clean).  
**Historical G3 reference:** `1c93f0ed71ca45620ddc238f98fd6391b5a1f054` (`v2.0.1`)  
**Full requirements:** `PRD.md`  
**Detailed design:** `architecture.md`  
**Source crosswalk:** `SOURCE_CROSSWALK.md`

## 1. Product and scope

G4 builds a **provider-neutral, multi-client** bank integration foundation:

- `BankConnection` owns connection identity, credential **references**, auth lifecycle, and connection health.
- `BankAccount` owns physical account identity, client/estate association, and current connection link.
- Co-op is the only implemented G4 adapter; its overall `operationalReady` remains `false` pending provider verification.
- Polling and webhooks share one normalized ingestion path into **existing G3** reconciliation and `accountingPosting`.

**NON-GOAL:** G5 Daraja/M-PESA. **NON-GOAL:** second Ledger/Payment engine. **NON-GOAL:** implementing KCB/EQUITY/NCBA in G4.

## 2. GitHub is the source of truth — mandatory

1. Fetch latest GitHub `main` before every implementation session; record HEAD SHA.
2. Diff against this document’s verified SHA; re-read changed banking/G3 callers.
3. Never destructive-reset local work to force-match GitHub.
4. If HEAD advances, stop and report impact before coding on a stale baseline.

## 3. Historical source snapshot (`e0b49c2`; original pre-G4 baseline)

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
- The verified repository source tree is `src/`; this branch has no `g4/` directory. Change only the existing, requirement-scoped `src/` paths and their tests. Do not create a parallel `g4/` tree. Any future source-root migration requires an explicit approved migration and synchronized documentation.
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
- **As-built mismatch to fix:** the COOP strategy selected by `/bank/accounts/:id/sync` is FullStatement date-window retrieval, but `hasBankSyncEntitlement()` currently accepts `poll === true || statement === true`. A poll-only account can therefore authorize the wrong provider resource. Required: FullStatement uses `statement === true`; AccountTransactions polling, when later verified, uses `poll === true` only.
- Manual `bank.service.importStatement()` checks statement entitlement and active connection at request start, but does not currently repeat the parent-connection check after the provider response or apply the same explicit provider readiness/lab gate used by sync. Correct this before enabling manual import outside the controlled lab.
- Parent `BankConnection.status` is separate from `BankAccount.connectionStatus`. Disconnect currently changes only the parent record; child account status/entitlements remain stale. Effective account operations and public DTOs must account for current parent status.
- The webhook currently checks account linkage/entitlement but not the referenced parent connection's active status. Add the parent check before ingestion whenever the callback route is exposed (lab or later operational mode).
- Inbound INS Basic remains platform/application-level according to current contract evidence, not per-connection.
- Local regression, HTTP integration and Mongo concurrency evidence is recorded in the final implementation review. None of it substitutes for provider sandbox verification.


## 9. Co-op Connect 2.0.0 correction rules (READ BEFORE BANKING CHANGES)

Full evidence and file-by-file requirements: [`docs/provider-contracts/COOP_CONNECT_2_0_0_ALIGNMENT.md`](docs/provider-contracts/COOP_CONNECT_2_0_0_ALIGNMENT.md).

- **Never confuse IDs:** `BankConnection.clientId` is the Tycoon Client ObjectId from authenticated client context. Co-op OAuth `clientId` is the bank-issued Consumer Key inside encrypted credential material. Preserve Tycoon ownership; rename UI/API credential fields to `consumerKey` / `consumerSecret`.
- Normal customer onboarding accepts CK/SK only. The Co-op guide documents a CK/SK `client_credentials` token request. Password grant is also documented but is not the default and is not proven necessary for the resources Tycoon calls. Do not require username/password or ask for a retail banking login.
- Token POST URL and API resource URLs are separate configuration. Use exact documented versioned paths; never invent endpoint suffixes or scopes. The generic `apim:subscribe apim:api_key` sample is not proof of account-enquiry scope.
- Account Validation: `/Enquiry/Validation/Account/1.0.0`; MessageCode `0` valid, `-1` invalid. Invalid account is not provider outage; only `valid === true` can activate an account.
- FullStatement must map its documented `CreditAmount` / `DebitAmount` / C-D / `TransactionId` item shape consistently for manual and scheduled imports. Do not weaken G3 validation or idempotency.
- AccountTransactions polling stays disabled until the transaction identifier is proved stable and its item mapping is verified. MiniStatement's supplied sample has balances and no transaction list. Balance endpoint path is still unverified.
- Never persist inbound INS `Basic` credential in rawPayload/quarantine/logs. It is distinct from outbound CK/SK.
- Keep Co-op `operationalReady=false` until token/resource scopes, endpoint contracts, sandbox behavior and callback gates have evidence. Detailed acceptance tests and blocked questions are in the linked audit.
- The guide's PHP POST and Java GET client-credentials examples conflict; POST with the explicit grant body is the implementation target, not sandbox proof. Do not infer client-credentials TTL/refresh from the password-grant sample.
- DCR application-key issuance and Tycoon customer account authorization are separate. `saasApp: true` does not prove multi-customer account access; obtain Co-op confirmation.
- AccountTransactions is an `/Enquiry/` operation. Its “Pesalink funds transfer” caption is misleading; no transfer contract is established. Its sample has `TransactionReference` but no `TransactionId` or uniqueness guarantee, so polling stays disabled. MiniStatement's KES value is account-summary currency, not transaction-item currency.

## 10. Co-op effective connection state and resource-specific authorization

BankAccount.connectionStatus is not a mirror of BankConnection.status. Keep both meanings separate and derive an effective capability from the account's validated link, its account entitlement, the current parent connection status, the provider readiness gate and the environment's permitted lab policy.

Do not treat `poll` and `statement` as synonyms. The currently selected COOP sync strategy fetches FullStatement, so its operation gate is `statement === true`. The AccountTransactions polling capability remains false until its item identity/ordering contract is verified; when eventually enabled, it must be gated independently by `poll === true`.

A disconnected parent connection must make sync, manual statement import and webhook ingestion unavailable even while child account flags remain connected/true. Manual statement import must re-check parent state after the provider call before committing the returned page. The frontend must receive or derive the effective parent state, but the backend remains authoritative.

A create response can be HTTP 201 with connection status failed. This records a created resource whose initial authentication failed; it is not a successful provider authorization. Keep this distinction visible in API docs and UI acceptance tests.