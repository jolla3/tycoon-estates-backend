# G4 Product Requirements Document: Bank Connections and Co-op Integration

**Status:** Architecture locked for implementation.  
**Repository:** `jolla3/tycoon-estates-backend`  
**Verified GitHub `main` HEAD:** `e0b49c2f122be7ae3ed14eaba9eecfeacee7ce13` (`v2.0.3`)  
**Workspace:** Matches HEAD (`diff` clean for `src/`, `tests/`, `scripts/`, package files).  
**Programme:** After G3 (tenancy-aware accounting); before G5 (Daraja/M-PESA).

> GitHub is authoritative. Fetch and inspect current `main` HEAD before planning or changing code.

## 1. Product definition

Tycoon Estates monitors rent payments for multi-estate clients. G4 enables secure, multi-client bank connectivity so credits on client bank accounts can be discovered (poll or webhook) and attributed through the **existing G3** financial engine.

G4 must ensure:

- Independent API relationships per Tycoon client (and multiple per client when needed).
- No cross-client credential, token, account, or transaction leakage.
- Duplicate provider events cannot create duplicate Payments or Ledger effects.
- Operational failure is visible; success responses must not conceal partial failure.
- Account activation cannot occur when validation fails or is unavailable.

## 2. Scope

### 2.1 In scope

| ID | Capability |
|----|------------|
| G4-S1 | BankConnection model and lifecycle |
| G4-S2 | Connection-scoped credentials in encrypted MongoDB `BankCredential` records, referenced by `BankConnection`, with token isolation |
| G4-S3 | BankAccount link to one connection; physical-account identity preserved |
| G4-S4 | Truthful provider registry: COOP adapter implemented but not operationally ready; KCB/EQUITY/NCBA disabled |
| G4-S5 | Shared normalized ingestion (poll + webhook) |
| G4-S6 | Durable account-scoped sync checkpoints and recovery |
| G4-S7 | Webhook verification using the **verified** Co-op mechanism only |
| G4-S8 | Hand-off to existing G3 reconciliation and accountingPosting |
| G4-S9 | Backend API contract for an external frontend |
| G4-S10 | Monitoring, redaction, production readiness |

### 2.2 Provider boundary

Identifiers **PRESERVE:** `COOP`, `KCB`, `EQUITY`, `NCBA`.  
Only COOP is implemented. Unimplemented providers MUST NOT be connectable or advertised as operational.

### 2.3 Non-goals

- G5 M-PESA / Till / PayBill.
- Second Payment, allocation, RentCharge, or Ledger engine.
- KCB / Equity / NCBA adapters in G4.
- Storing retail internet/mobile banking passwords, PINs, OTPs, or card data as connection secrets.
- Inventing UK Open Banking FAPI/mTLS patterns for Kenya Co-op Connect.
- Frontend implementation in this repository.
- Cross-client account transfer as an ordinary product flow.

## 3. Verified source observations (`e0b49c2`)

- No `BankConnection` model.
- `BankAccount`: unique `{provider, accountNumberHash}`; `connectionStatus` pending/connected/failed; `lastSyncedAt`.
- `BankTransaction`: unique `{provider, providerTransactionId}`; processing states; unused claim fields; `matchedTenancyId`.
- Credentials: process env `COOP_*`; token cache on factory singleton keyed by provider name.
- `connectAccount` may set `connected` after validation errors (non-compliant with locked fail-closed rule).
- `withIdempotency` uses `providerTransactionId` alone; unique index is compound with `provider`.
- Webhook path hardcodes COOP and duplicates persist+reconcile logic.
- G3 path already receives normalized BankTransactions via `reconciliationService`.

Agents MUST re-verify against current GitHub HEAD before coding.

## 4. Actors and trust boundaries

| Actor | May | Must not |
|-------|-----|----------|
| Client owner/admin | Manage own connections and accounts | Access other clients’ credentials or accounts |
| Estate-restricted staff | View permitted estate bank data | Mutate outside estateFilter |
| Co-op API / callback sender | Deliver data under verified contract | Select target client or bypass verification |
| Tycoon backend | Validate ownership, ingest, reconcile, audit | Log secrets; invent provider behaviour |

## 5. Normative keywords

MUST, MUST NOT, SHOULD, MAY, BLOCKED BY VERIFICATION, ACCEPTANCE CRITERIA, INVARIANT, NON-GOAL, VERIFIED, PROPOSED.

**OWNER DECISION** is reserved for genuinely open product choices. Ownership, identity, fail-closed validation, connection-scoped encrypted credential storage, multi-connection support, and G3 sole authority are **locked** and MUST NOT be reopened as OWNER DECISION items.

## 6. Product rules and data ownership

### 6.1 Connection versus bank account (LOCKED)

- One **BankConnection** belongs to exactly one Tycoon client and one provider.
- A client MAY have multiple independent connections to the same provider.
- One connection MAY authorize multiple **BankAccounts**.
- A **BankAccount** represents one physical bank account.
- One physical account MUST NOT be simultaneously registered to different Tycoon clients.
- Global physical-account identity constraint **PRESERVE:** unique `{provider, accountNumberHash}` unless a separately justified and approved migration is established.
- Each BankAccount has one current client, estate, and connection association.
- Estate reassignment is explicit and audited.
- Historical BankTransactions retain original ownership context (`clientId`, `estateId`, `bankAccountId` at ingest time).

### 6.2 Reconnect (LOCKED)

- Reconnecting the same physical account through another connection **belonging to the same client** MUST reuse the existing BankAccount record and preserve its `_id`.
- Cross-client transfer is not ordinary reconnect and is **not authorized** by this architecture.
- Disconnecting a connection MUST stop future sync and credential use without deleting historical BankAccount, BankTransaction, Payment, allocation, or Ledger records.

### 6.3 Credentials (LOCKED)

- Customer-specific bank API credentials MUST be scoped to their owning `BankConnection`.
- MUST NOT use shared global environment credentials as a fallback for customer-specific authentication.
- Durable customer credential material MUST be stored in the MongoDB `bankcredentials` collection as an AES-256-GCM encrypted envelope in `BankCredential`.
- `BankCredential._id` MUST equal the opaque `BankConnection.credentialsRef`; owner, provider and `credentialVersion` MUST match the referencing connection.
- Plaintext credential material MUST NOT be persisted in MongoDB, Redis, logs, API responses, or migration reports.
- The destination encryption key MUST be separate from the existing account-number encryption key and backed up independently of MongoDB.
- Redis MUST NOT be the credential source of truth or a cache for decrypted credentials. It remains limited to temporary infrastructure state.
- Authentication token state MUST be isolated by connection and credential version.
- Provider instances MUST NOT share customer authentication state through a provider-name singleton.

### 6.4 Financial hand-off (LOCKED)

- After durable BankTransaction persistence, CREDIT processing MUST use existing G3 reconciliation → accountingPosting paths only.
- G4 MUST NOT create Payment, PaymentAllocation, RentCharge, or Ledger rows outside that path.

## 7. Functional requirements

### Connection lifecycle

| ID | Requirement |
|----|-------------|
| G4-FR-CONN-001 | Authorized create/inspect/reauthorize/disconnect for BankConnection |
| G4-FR-CONN-002 | Connection status reflects auth health (e.g. active, reauth_required, disconnected, failed) without deleting history |
| G4-FR-CONN-003 | Credential version increments on secret rotation; prior token cache for that connection invalidated |

### Account linkage

| ID | Requirement |
|----|-------------|
| G4-FR-ACCT-001 | Link BankAccount to connection + estate under same client |
| G4-FR-ACCT-002 | Failed or unavailable account validation MUST NOT set account to `connected` / activated |
| G4-FR-ACCT-003 | Account-level API entitlements MUST be represented and checked before using a capability |
| G4-FR-ACCT-004 | Same-client physical reconnect updates existing row; preserves `_id` |

### Registry and adapters

| ID | Requirement |
|----|-------------|
| G4-FR-REG-001 | Capability APIs report only implemented + configured + verified capabilities |
| G4-FR-REG-002 | Connect attempts for unimplemented providers fail closed |
| G4-FR-REG-003 | Provider-specific auth, schemas, mapping, webhook verify stay inside the adapter |

### Ingestion and idempotency

| ID | Requirement |
|----|-------------|
| G4-FR-ING-001 | Poll and webhook share one normalize → ownership validate → durable persist → process pipeline |
| G4-FR-ING-002 | Direction MUST be explicit and validated; unknown/ambiguous direction MUST NOT default to CREDIT |
| G4-FR-ING-003 | Idempotency lookup MUST match the actual unique index key shape |
| G4-FR-ING-004 | Preserve unique `{provider, providerTransactionId}` until provider guarantees justify a staged change |
| G4-FR-ING-005 | Stored but unreconciled transactions remain retryable; sync success MUST NOT imply all posted |

### Synchronization

| ID | Requirement |
|----|-------------|
| G4-FR-SYNC-001 | Each account owns durable checkpoint metadata for last **accepted** work |
| G4-FR-SYNC-002 | Checkpoints MUST NOT advance past data that failed durable write |
| G4-FR-SYNC-003 | Scheduled and manual sync use the same account-level coordination |
| G4-FR-SYNC-004 | Stale workers MUST NOT overwrite newer checkpoint state (fencing / conditional writes) |

### Webhooks

| ID | Requirement |
|----|-------------|
| G4-FR-WH-001 | Requests pass the verified provider authentication mechanism before processing |
| G4-FR-WH-002 | Account resolution by verified account identity → exactly one connected account under an active connection |
| G4-FR-WH-003 | Cryptographic signatures only if official Co-op contract specifies them (**BLOCKED BY VERIFICATION** otherwise) |

### Authorization and redaction

| ID | Requirement |
|----|-------------|
| G4-FR-AUTHZ-001 | All authenticated bank APIs enforce client scope and estateFilter |
| G4-FR-AUTHZ-002 | Credential material, encryption keys, tokens and encrypted envelopes MUST NEVER appear in API responses, logs, or stored rawPayload headers |

## 8. Non-functional requirements

| ID | Requirement |
|----|-------------|
| G4-NFR-01 | MongoDB `BankCredential` encrypted-envelope storage; separate encryption-key custody and recovery |
| G4-NFR-02 | Existing ENCRYPTION_KEY discipline remains for account-number ciphertext / HMAC |
| G4-NFR-03 | Webhook rate limiting PRESERVE |
| G4-NFR-04 | Migrations: versioned, dry-run/preflight, allowlisted DB for execute |
| G4-NFR-05 | Tests: unit + disposable replica-set integration; G3 regression |
| G4-NFR-06 | Bank transaction retention beyond ten days is permitted |

## 9. Acceptance criteria (summary)

1. Two clients cannot observe each other’s credentials, tokens, or accounts.  
2. Two connections for the same client/provider cannot share token state.  
3. Duplicate webhook + poll yields at most one BankTransaction and at most one G3 Payment effect.  
4. Validation failure never activates an account.  
5. Same-client physical reconnect preserves BankAccount `_id`.  
6. Checkpoint does not advance past unaccepted pages.  
7. Unknown transaction direction is rejected, not credited.  
8. Unimplemented providers are not connectable.  
9. G3 tenancy isolation and allocation tests still pass.  
10. No secrets in logs or API bodies.

## 10. Delivery phases

1. Models, indexes, safe migrations  
2. Connection-scoped credentials and auth isolation  
3. Provider registry and adapter contract  
4. Co-op adapter (verified only)  
5. Shared ingestion and idempotency  
6. Account-scoped sync, checkpoints, recovery  
7. Webhook via shared pipeline  
8. G3 reconciliation regression  
9. API contract / frontend boundary  
10. Monitoring and production readiness  

## 11. External verification gates (remain BLOCKED until evidence)

| Gate | Until evidence |
|------|----------------|
| Co-op grant type, scopes, token TTL/refresh | No guessed scopes; gate live auth features |
| Account validation response semantics | Fail closed on unavailable/failed validation |
| Polled AccountTransactions item schema | Do not trust unverified mapper for production finance |
| TransactionId uniqueness scope | Do not change unique index |
| SendTransactionINS auth beyond Basic shared secret | Do not invent signatures |
| Callback subscription/retry guarantees | Capability flagged not provisioned if unknown |
| Pagination/window ordering | Do not invent checkpoint cursor semantics from guesses |

## 12. Frontend boundary

No frontend source in this backend repository. G4 defines backend HTTP contracts only.

## 13. Document control

`PRD.md`, `architecture.md`, and `architecture-summary.md` MUST remain consistent. Root G3 documents are not modified by G4. `SOURCE_CROSSWALK.md` records source→target mapping at lock time.

## G4 provider readiness and lab execution boundaries

**Verified implementation status as of 2026-11-12**

- `implemented` and `operationalReady` are separate states. An adapter existing does not authorize production traffic.
- COOP has an implemented adapter, but its overall `operationalReady` remains `false`. KCB, EQUITY and NCBA remain disabled shells. No bank provider is currently declared operational.
- COOP connection creation and account linking may use `COOP_BANK_LAB_MODE=1` only outside production. The default is disabled. The flag does not change the provider readiness profile.
- COOP FullStatement synchronization requires the account's `statement` entitlement or `poll` entitlement and the registered FullStatement strategy. AccountTransactions list polling remains disabled.
- Sync entitlement is revalidated during execution. Revocation of both polling and statement entitlements prevents continued synchronization.
- COOP webhook exposure requires webhook capability readiness or `COOP_WEBHOOK_LAB_OVERRIDE=1` outside production. The override never authorizes production exposure.
- Lab mode does not bypass credential authentication, account validation, tenant ownership, callback authentication, quarantine or shared transaction ingestion.
- The inbound Co-op INS Basic credential remains platform/application-level under the currently documented provider evidence. Do not represent it as a per-connection credential.
- Sandbox verification remains outstanding. Passing local tests is not evidence of a successful provider sandbox session or production approval.
