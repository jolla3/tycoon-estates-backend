# Co-op Connect APIs 2.0.0 — Implementation Traceability and Preflight Challenge

**Status:** pre-implementation specification. No application code is changed by this document.  
**Audited implementation baseline:** `jolla3/tycoon-estates-backend` branch `docs/superadmin-onboarding-and-history` at `2f1bad7fd674babf26fd86e51036a4be0ea06ad6`; `jolla3/tycoon-frontend` branch `docs/superadmin-onboarding-and-history` at `bd78e8867f2642d77333d1dfc1f408235e179bbf`.  
**Audit specification sources:** backend alignment commit `98cc95185b32507f5e3af8349acd824439cee015`; frontend alignment commit `a424179496f17b5ab905763403cdfa2c210bfce6`.  
**Rule:** source line references below describe the audited baseline and will move after implementation. The source files at the baseline SHAs are the evidence, not these line numbers.

## 1. Implementation boundary

This is a cross-repository correction to the existing G4 bank-connection and statement-ingestion path. It is not a new banking subsystem.

Preserve:
- Tycoon ownership: `BankConnection.clientId` is the owning Tycoon Client ID. It is not Co-op's OAuth Consumer Key.
- Existing connection-scoped encrypted secret storage, secret-manager owner checks, immutable credential versions and staged compare-and-set reauthorization.
- Existing BankAccount identity, validation state, estate scope, sync lease/fence, transaction provenance, idempotent ingestion and G3 reconciliation/posting boundaries.
- Provider separation: Co-op-specific credentials, grant configuration, endpoints, mappers and readiness stay in the Co-op adapter.
- No provider operation can bypass the authenticated client context, selected-client query scope, BANKING product entitlement or existing estate restrictions.

Do not add another credential store, client-wide/global customer-key fallback, a second ledger, or a frontend route that bypasses the existing bank API.

## 2. Requirement-to-file matrix

| Requirement | Audited frontend behaviour | Audited backend behaviour | Required implementation result | Primary files | Required proof |
|---|---|---|---|---|---|
| C2-001/002 — normal credential contract | `CoopCredentialMaterial` requires `clientId`, `clientSecret`, `username`, `password`, optional `scope`; form labels and validation require those fields. | `credentialMaterial` is accepted as an untyped record. Adapter expects the same obsolete fields. | Normal customer onboarding accepts only `consumerKey` (CK) and `consumerSecret` (SK). No username, password, OTP, PIN or customer internet-banking credentials. No customer-entered generic scope. Never conflate CK/SK with Tycoon owner `clientId`. | FE `src/lib/api/bank-connections.ts`, `src/features/banking/banking-setup-panel.tsx`; BE `src/utils/validators.js`, `src/services/connection.service.js`, `src/services/banking/bank.factory.js` | FE type/form tests; strict Zod accept/reject tests; request contract test; secret-store owner/version regression. |
| C2-003/004/005 — validation and ownership | API sends the old credential fields. | Validator uses `z.record(z.any())`; connection service correctly stores secret material through the existing secrets manager and binds it to Tycoon client/provider/version. Factory passes old field names to the adapter. | Replace loose input with a strict provider-specific schema. Reject unknown credential fields. Map CK/SK only to Co-op adapter names. Preserve `BankConnection.clientId`, `credentialsRef`, secret-manager owner and monotonic `credentialVersion`. | BE `src/utils/validators.js`, `src/services/connection.service.js`, `src/services/banking/bank.factory.js`, `src/services/banking/secretsManager.js`; FE API/type | Tests prove missing/extra credentials reject and one Client cannot read another Client's secret. |
| C2-006/015/017/020 — OAuth grant and token lifecycle | UI exposes scope as optional free-form text and sends it to backend. | `coop.auth.js` requires password grant; adapter-local token fields hold token/refresh/expiry. Factory creates connection-scoped adapters and passes connection/version identity, but token reuse is only per adapter instance. | Ordinary customer linking uses CK/SK with documented `client_credentials` POST and Basic client authentication. Resource token type/grant/scope remain trusted provider configuration, not user form input. Do not globally delete password-grant capability if a future resource explicitly requires a user token; do not use it for ordinary onboarding without resource evidence. Coordinate/cache by connection ID, credential version, grant, scope and token endpoint; coalesce concurrent acquisition; invalidate on rotation. Use actual token response expiry only; never invent a 3600-second fallback or assume refresh-token support. | BE `src/services/banking/providers/coop/coop.auth.js`, `coop.provider.js`, `src/services/banking/bank.factory.js`, `src/services/connection.service.js`, `src/config/environment.js` | Auth HTTP tests for exact Basic header, form body and grant; token response validation; concurrent request single-flight; expiry; connection isolation; rotation invalidation; failure preserves previous credential version. |
| C2-007/008 — resource routes and host configuration | Frontend uses existing Tycoon API routes; no direct Co-op resource calls. | Provider uses guessed paths `/AccountValidation`, `/AccountTransactions`, `/AccountFullStatement`, `/AccountBalance` on one base URL. | Use documented versioned resource routes: Account Validation `POST /Enquiry/Validation/Account/1.0.0`; AccountTransactions `POST /Enquiry/AccountTransactions/1.0.0/Account`; MiniStatement `POST /Enquiry/MiniStatement/Account/1.0.0`; FullStatement uses its separately documented sandbox server/path `https://openapi-sandbox.co-opbank.co.ke/Enquiry/FullStatement/Account/1.0.0`. Configure token URL and each resource host independently. Do not infer production hosts or copy insecure TLS examples. | BE `coop.provider.js`, `coop.client.js`, `src/config/environment.js` | URL composition tests per resource/environment; no production URL assertion without provider evidence; HTTPS certificate verification remains enabled. |
| C2-009 — resource request schemas and account number | UI sends account number but has no resource-specific format behaviour. | `CoopAccountNumber` is globally `length(14)`; same schema is reused across resources. `NoOfTransactions` is an integer in Zod. | Make schemas resource-specific. Preserve the documented AccountTransactions serialization/maximum (maximum example 500; supplied example representation is a string) and test the exact outbound JSON. Do not apply FullStatement's 14-character schema globally: Account Validation examples include 11 digits while FullStatement declares 14. Treat this as unresolved per-resource input evidence; reject unsupported formats safely until Co-op confirms. | BE `coop.schemas.js`, `coop.provider.js`, account-registration validator | Resource schema tests for 11/14 examples, invalid lengths, NoOfTransactions boundary and serialized type; sandbox fixture verification when available. |
| C2-010/021 — provider error semantics | UI currently renders generic API message; provider-specific safe categories are not fully modelled. | Client logs raw `err.response.data`, converts HTTP failures and non-zero `MessageCode` to generic `BankProviderUnavailable`; Account Validation errors can be wrapped as `InvalidRequest`. | Map documented HTTP/MessageCode pairs to stable safe categories: invalid parameter, invalid account, token/auth, wrong token type, forbidden/unsubscribed, insufficient scope, throttling, hard throttle, timeout and upstream unavailable. Do not retry rejected requests blindly. Never log raw bodies, access tokens, CK/SK, account numbers or callback Basic. Preserve token/scope/timeout/throttle failures instead of relabelling them as customer input errors. | BE `coop.client.js`, `coop.auth.js`, `bank.service.js`, shared error mapping; FE error presentation | Table-driven response mapping tests; logs asserted free of secrets/raw payload; FE tests for stable category-to-message handling. |
| C2-011/012 — FullStatement mapping | UI displays sync/import counts but does not control provider mapping. | `getFullStatement()` maps response items through `mapCoopPolledTransaction`; scheduled strategy then tries to reconstruct using `rawPayload` and `mapCoopFullStatementItem`. Manual import does not get the scheduled workaround. | `getFullStatement()` must return canonical items from `mapCoopFullStatementItem`. Remove the scheduled-only remapping workaround. Manual and scheduled FullStatement paths must ingest identical normalized fields. Preserve `TransactionId`, `TransactionReference`, `TransactionDate`, `ValueDate`, credit/debit direction, and amounts. Do not change uniqueness scope/index until provider proves `TransactionId` scope. | BE `coop.provider.js`, `coop.mapper.js`, `coop.syncStrategy.js`, `bank.service.js` | One shared fixture tested through adapter, scheduled sync and manual import; same normalized result; missing/contradictory amount cases fail safely; duplicate identity tests retain current idempotency. |
| C2-013 — Account Validation semantics | Account registration flow assumes backend validation status. | `validateAccount()` returns `{ valid: true }` after any successful HTTP response, regardless of `MessageCode`; persistence path must not accept any non-true result. | Map `MessageCode 0` to valid and documented `-1` to invalid account. Unknown/malformed/contradictory responses are provider/contract failures, not valid. Caller must require `valid === true` before writing/activating BankAccount. Distinguish invalid account from auth, throttling, scope and transport failure. | BE `coop.provider.js`, `coop.client.js`, `bank.service.js`, `coop.schemas.js` | Tests for 0, -1, missing code, unknown code, HTTP 401/403/408/429/503; no BankAccount activation except explicit valid. |
| C2-014 — INS Basic callback secret | No frontend secret field is intended for inbound callback Basic. | Callback Basic is application-level configuration, but raw callback body can be passed to quarantine; provider logs can retain unredacted response data. | Keep inbound INS Basic separate from outbound per-connection CK/SK. Remove/mask Basic before logging, quarantine persistence, audit metadata or error serialization. Do not infer a cryptographic signature contract. Callback processing remains disabled unless its exposure/readiness policy is explicitly met. | BE `src/routes/webhook.routes.js`, `coop.provider.js`, callback quarantine service, logger | Raw callback fixture containing Basic; assert secret absent from logs/quarantine/audit; reject invalid auth; production exposure remains denied. |
| C2-016 — capability truthfulness | UI has no authoritative source for parent/provider operational readiness. | Registry marks statement, webhook and balance statically true although readiness profile says sandbox or contract is unverified. Account entitlements are derived from static registry flags. | Separate adapter presence, contract verification, capability implementation, account entitlement, lab allowance and production readiness. Unknown/unverified must be unavailable. Balance and webhook stay unavailable in production until evidence and readiness are complete. Polling stays disabled. FullStatement is a documented contract path but not sandbox-verified; any use is restricted to the explicit non-production lab policy. | BE `bank.factory.js`, `coop.readiness.js`, `bank.service.js`, `providerReadiness.js`; FE capability rendering | Readiness matrix tests in production/development/lab; no capability becomes operational from registry presence alone. |
| C2-022 — strategy-specific authorization | UI derives `canSync` from `poll !== false`; undefined is treated as enabled. Button is labelled “Sync now”. | Co-op strategy is `full_statement_window`, but generic `hasBankSyncEntitlement` accepts `poll === true OR statement === true`. The sync endpoint therefore does not express the actual resource capability. | FullStatement date-window sync requires `statement === true`. AccountTransactions polling requires `poll === true` only if later verified and enabled. One entitlement never authorizes the other. Rename UI action to describe a recent statement-window sync. Keep AccountTransactions polling UI and capability disabled. | FE `banking-setup-panel.tsx`; BE `bankSync.service.js`, `coop.syncStrategy.js`, routes/controllers | Poll=true/statement=false rejects FullStatement; statement=true/poll=false permits only FullStatement under allowed readiness; unknown/undefined rejects. |
| C2-023/025 — effective parent connection state | Account cards receive BankAccount only; they do not join the parent BankConnection. Buttons can remain visible after parent disconnect. | Disconnect changes BankConnection.status only. Child account may retain `connectionStatus=connected` and old entitlements. Sync/import checks parent in some paths; webhook does not load parent. | Keep child account-link state distinct from parent connection-auth state. Derive effective availability from current parent: parent must exist, same client, same provider and be active. Missing parent fails closed. Expose safe parent/effective state in DTO or join existing live connections query in FE. UI disables all operations for inactive/missing parent. Backend independently enforces the same rule. Avoid a non-atomic child cascade as the sole security control. | FE `banking-setup-panel.tsx`, `bank-connections.ts`, bank types; BE `connection.service.js`, `bank.service.js`, `BankConnection.js`, `BankAccount.js`, controllers/DTO | Active/failed/reauth_required/disconnected/missing/mismatched parent tests; frontend rendering tests; cross-client/provider mismatch rejected. |
| C2-024 — manual import readiness and race | UI statement dialog can be opened from stale child flags. | `importStatement()` checks child state, statement flag and active parent before provider call, but lacks the same readiness/lab gate as scheduled sync and does not recheck parent/credential version after provider response before ingestion. | Apply the same provider operational/lab gate as scheduled FullStatement sync. Capture connection ID + credential version before fetch; after response, re-read account and parent and confirm same client/provider/connection/version, active status, account validation and statement entitlement before ingestion. Any disconnect, reassignment, rotation or revocation during fetch rejects the stale response. | BE `bank.service.js`, `connection.service.js`, transaction ingestion | Race tests pause provider response, then disconnect/rotate/revoke/reassign; no stale rows ingested; readiness policy parity tests. |
| C2-023 — webhook parent validation | No direct frontend control. | Webhook matches a connected BankAccount by account-number hash and checks child webhook entitlement, but does not verify current parent BankConnection. | Before normalize/ingest, load and verify parent connection by child `connectionId`, same `clientId`, provider COOP and active status; check effective webhook capability/readiness. Missing/mismatched/disconnected parent must be rejected or safely quarantined without ingestion. Repeat current-state validation immediately before write if processing can race with disconnect. | BE `src/routes/webhook.routes.js`, callback quarantine, `BankConnection`, ingestion service | Parent missing/disconnected/wrong-client/wrong-provider and disconnect-during-callback tests; no transaction insert/processing. |
| C2-026 — create and reauthorization outcomes | Frontend must not treat response receipt alone as successful authorization. | Create persists a failed BankConnection after initial auth failure and controller still returns HTTP 201. Reauth stages new secret and CAS-promotes only after auth; failure preserves prior version but returns generic auth error. | HTTP 201 means resource created, not that provider auth succeeded. FE inspects returned status and clearly shows failed authorization. Reauth only marks active on successful promotion; preserve old version on failure and present stable safe error category. For uncertain persistence outcomes, reload state before retry; never blindly retry rotation. | FE `banking-setup-panel.tsx`, `bank-connections.ts`; BE `connection.controller.js`, `connection.service.js`, error mapper | Create returns status=failed -> failed UI; reauth auth failure preserves old secret ref/version; typed categories do not expose raw provider response; uncertain result prompts reload. |
| Frontend secret state — cleanup accuracy | Secrets are local component state, not query cache/storage. On cancel/close/success they are wiped; on API error they are retained for retry. The code comment currently overclaims “wiped on every exit path”. | Backend does not echo credential material in public DTOs. | Preserve ephemeral state only. Correct the comment and add an explicit discard/clear action after failure; close/cancel must wipe; success wipes; never log or echo values. | FE `banking-setup-panel.tsx` | Component tests inspect state transitions without asserting secret text in DOM/log/output. |
| Frontend scope/cache/superadmin — selected client remains explicit | Superadmin passes `clientId` query scope; mutation invalidation covers banking keys but not the selected parent client summary cache. Account card is not joined to connections. | `clientContext` requires explicit active client for SUPER_ADMIN and discards body-supplied identity. | Preserve explicit query clientId and BANKING entitlement. Never take owner identity from body. Join parent/effective state for rendering. After connection/account mutations, invalidate the selected client summary `platformKeys.client(clientId)` as well as banking keys. | FE `banking-setup-panel.tsx`, `src/lib/query/keys.ts`; BE `clientContext.js`, routes | Superadmin cross-client isolation; no body spoof; cache refresh after create/reauth/disconnect/register. |
| Account display name | UI's account name label can be read as bank-verified identity. | Account Validation confirms account validity only; it does not return a verified holder name. | Label `accountName` as an internal Tycoon display label. Do not call it verified bank account holder/name. | FE registration dialog and account card; BE account DTO | UI copy test; response contract does not fabricate holder name. |
| G3/ledger boundary | FE uses existing transactions experience and banking endpoints. | Statement ingestion flows into existing bank transaction/reconciliation services. | Do not alter tenancy selection, G3 payment posting, allocations, credits, ledger ownership or reconciliation semantics to compensate for Co-op auth/mapper defects. Treat provider receipts as bank transactions; only existing G3 gates may post. | BE `transactionIngestion.service.js`, reconciliation/G3 services; FE existing Transactions | G3 regression suite; duplicate/replay, unmatched and already-posted cases retain existing outcomes. |
| Verification and delivery claims | PR #4 currently has no dedicated frontend banking component/API test evidence. | Co-op mapper/schema/client and bank integration tests exist, but no proof all cross-layer scenarios pass at this baseline. | Add missing targeted suites. Report unit, HTTP integration, replica-set, frontend build/component, G3 regression and sandbox results separately. A compile or mocked unit test is not sandbox verification or production readiness. | Both repositories | Requirement-linked test report with exact command/result, environment and remaining blockers. |

## 3. Provider evidence and non-assumptions

### Confirmed from the supplied Co-op Connect 2.0.0 material
- DCR is application registration. Its returned Co-op OAuth `clientId`/`clientSecret` are CK/SK, not Tycoon's `BankConnection.clientId`.
- The guide documents both a password-grant example and a CK/SK-only `client_credentials` PHP example. The normal Tycoon customer flow targets CK/SK-only application authentication; password grant must not be assumed for ordinary onboarding.
- The generic password-grant scope example is not proven to be the scope for the account-enquiry APIs.
- Account Validation: `POST /Enquiry/Validation/Account/1.0.0`; MessageCode `0` means valid and `-1` means invalid.
- AccountTransactions: `POST /Enquiry/AccountTransactions/1.0.0/Account`; polling is not enabled until stable transaction identity and list-response semantics are proven.
- MiniStatement: `POST /Enquiry/MiniStatement/Account/1.0.0`; supplied sample is account summary/balance information, not a transaction feed.
- FullStatement uses its separate versioned OpenAPI server and has a documented transaction item schema, including TransactionId, TransactionReference, CreditAmount, DebitAmount, TransactionType C/D and separate transaction/value dates.
- The supplied FullStatement schema declares 14-character account numbers, while Account Validation examples include 11-digit values. Preserve the contradiction as unresolved.
- Balance has no verified exact path/request schema in the supplied evidence.

### Still unresolved; do not invent
1. Per-resource accepted OAuth token type, grant, exact scope and token lifecycle/TTL.
2. Production token/API hostnames and whether each resource uses the same API gateway.
3. Account-number accepted lengths/formats by each resource.
4. AccountTransactions stable ID uniqueness scope, page/list semantics and replay behaviour.
5. Balance path/schema and operational capability.
6. Callback acknowledgement/retry contract, authenticity guarantees beyond the supplied INS Basic credential, and production readiness.
7. FullStatement sandbox fixtures, field optionality at runtime and currency behaviour.

## 4. Pre-implementation design challenge

The following decisions must be answered in the implementation plan before code begins.

### 4.1 Token coordination and rotation races
- An adapter instance is not a durable cache boundary because adapters are reconstructed from the current connection in service calls. A service-level token coordinator is needed if tokens are to be reused.
- Cache identity must include connection ID, credential version, grant, scope and token endpoint (plus environment/resource identity where the token contract requires it). It must not share tokens across clients or rotated credentials.
- Concurrent requests for one cache key must share one acquisition promise; invalidating an old version must not invalidate a newly promoted version.
- Reauthorization keeps the existing staged-secret + compare-and-set promotion model. Token coordination must not bypass the CAS or mutate live credentials before authentication succeeds.
- A response with missing/invalid `expires_in` must not be assigned a guessed lifetime. Define a fail-closed policy supported by provider evidence.

### 4.2 Provider transport and error safety
- Separate token transport from resource transport. FullStatement's sandbox server cannot be silently treated as the default base for all resources.
- Error mapping must preserve stable safe categories while discarding raw messages/bodies that may contain account or secret material.
- A token refresh/reacquisition retry must be bounded and limited to safe enquiry operations. A wrong-token-type or insufficient-scope response must not trigger repeated identical token requests.
- Do not copy the supplied examples' insecure TLS switches into runtime configuration.

### 4.3 Account validation and ingestion boundaries
- Account Validation's explicit invalid result is a customer-data outcome; timeout/auth/scope/throttle/resource-not-found is not.
- Only `valid === true` can advance a candidate account to validated/connected and assign capabilities.
- FullStatement manual and scheduled imports must consume the same canonical mapper output.
- The transaction identity/index question remains unresolved until Co-op confirms TransactionId uniqueness scope. Do not weaken or casually replace existing idempotency keys.

### 4.4 Parent state, fencing and asynchronous responses
- A child BankAccount's stored state is not enough to authorize an operation. The parent connection must be active now, correctly owned and still on the expected credential generation.
- Disconnect during a long-running provider request must prevent the response from being ingested.
- Credential rotation during a provider request must likewise prevent data fetched under the stale generation from being accepted unless an explicit policy proves it safe.
- Keep the existing sync lease/fence and page-boundary checks. Add equivalent post-fetch checks to manual statement import.
- Webhook ingestion must not trust stale child flags. Parent check must happen before ingestion, and any race-sensitive write path needs a current-state guard.
- Avoid relying solely on a child cascade: a partial cascade can leave inconsistent records and must not be the only authorization layer.

### 4.5 Entitlement/readiness dimensions
Do not collapse these into one boolean:
1. Adapter exists.
2. Resource contract is documented.
3. Capability is implemented.
4. Customer account is entitled.
5. Non-production lab override permits the operation.
6. Provider has passed sandbox verification.
7. Production operation is approved.

The current registry conflates some of these. The corrected path must fail closed whenever a required dimension is unknown or false.

### 4.6 Frontend truthfulness and cache state
- An omitted entitlement is not permission. Frontend checks must use explicit `=== true`.
- The frontend must use the parent connection status when rendering account actions. A missing connection must disable all operations.
- The existing `POST /bank/accounts/:id/sync` operation is FullStatement date-window sync, not verified AccountTransactions polling. The label and capability gate must say so.
- HTTP 201 plus `status: failed` is a failed provider authorization, not an active connection.
- On an error, keeping typed CK/SK in ephemeral form state may support a retry, but the user needs an explicit discard action and the source comment must accurately describe the state.
- Selected Superadmin client scope must remain explicit, and the corresponding platform summary cache must be invalidated after mutations.

### 4.7 G3 ownership and transaction safety
- Co-op adapter changes stop at the existing BankTransaction/normalization boundary.
- Do not introduce a second rent ledger, direct Payment creation, or provider-specific shortcuts into tenant matching/reconciliation.
- Preserve duplicate detection, processing claims, lease fences, audit evidence and existing G3 posting rules.
- A valid provider transaction does not itself prove which tenant or estate should receive rent; existing Tycoon attribution/reconciliation rules remain authoritative.

## 5. Ordered implementation gates

1. **Documentation lock:** this matrix and both repository PRD/architecture documents agree; open questions remain visibly blocked.
2. **Backend contract and auth:** strict CK/SK boundary, grant/token configuration, token coordination, routes, request schemas, typed errors and Account Validation semantics.
3. **Backend statement and lifecycle:** canonical FullStatement mapping, explicit strategy entitlement, readiness gate, parent-state revalidation for sync/import/webhook, safe callback redaction.
4. **Backend test gate:** unit + HTTP integration + replica-set/race + G3 regression. Do not start frontend integration against an unstable API contract.
5. **API contract checkpoint:** publish exact request/response/status/error/effective-state contract for FE use; no inferred frontend fields.
6. **Frontend:** CK/SK UI, truthful connection status, parent-state join, strict capability controls, statement-window label, safe secret discard, typed errors and cache invalidation.
7. **Joint verification:** build, component/API tests, backend integration and G3 regression. Sandbox verification is separate and only reported if actually run.

## 6. Definition of done

- Every matrix row is either implemented and linked to passing tests, or explicitly blocked by provider evidence / environment availability.
- Frontend request shape, backend validation, Co-op OAuth, resource URLs, mapper, capability authorization and lifecycle agree.
- Disconnected/missing/mismatched parents and stale credential generations cannot authorize ingestion.
- Manual and scheduled FullStatement paths normalize identical fixtures.
- No raw secrets/provider payloads leak through logs, DTOs, caches, quarantine or audit metadata.
- Existing G3 transaction/ledger behaviour remains unchanged and passes regression.
- No AccountTransactions polling, Balance or production webhook capability is represented as available without its evidence gate.
- The final report names exact commits, tests and environments. No claim of sandbox or production readiness is made from source inspection or compilation alone.


## 7. Current-main source reconciliation — 21 November 2026

**Current backend main:** `0dbf7ef75ed6c1a39e24775aec9a86e08f7d0617`  
**Current frontend main:** `a27f20dd3244cdc7370cffa16b70c6cd32a45576`

The requirements above remain the target. The merged current source still does not satisfy the normal credential contract end-to-end:

- The frontend onboarding form sends the legacy `{ clientId, clientSecret, username, password, scope? }` shape.
- Backend strict create/reauthorize validation accepts `{ consumerKey, consumerSecret }` and rejects the legacy keys. This explains the observed 422 at validation.
- Updating only the frontend will not complete the repair: `bank.factory.js` still passes the legacy credential context, and the Co-op auth adapter still expects username/password/scope and uses the password grant.

The correction must align the frontend DTO, backend validator, credential mapping, provider auth implementation and tests with the G4 PRD/architecture decision: normal onboarding accepts Co-op CK/SK and uses the documented CK/SK-only `client_credentials` flow; grant/scope/resource configuration is trusted provider configuration, not landlord-entered data. `BankConnection.clientId` remains Tycoon's owning Client ID and must never be replaced with the Co-op Consumer Key.

This source correction does **not** clear unresolved resource-specific scope, token lifetime, production host or endpoint evidence. Keep unverified operations and `operationalReady` gated. Do not claim a working Co-op integration merely because the 422 is removed.

Required proof: frontend request-body tests; strict validator accept/reject tests; factory-to-auth credential mapping tests; token request fixture with no customer username/password; token cache isolation by connection/credential version/config; failure and rotation race tests; existing G3 reconciliation regression. Sandbox evidence remains a separate gate.
