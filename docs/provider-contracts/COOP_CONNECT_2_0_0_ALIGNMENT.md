# Co-op Connect APIs 2.0.0 - As-Built Gap Analysis and Required Changes

**Status:** Documentation/audit specification only. No application code is changed by this document commit.  
**Repository baseline:** `jolla3/tycoon-estates-backend` `main` at `25d9969eb4f1c734f360337f0a3d64b83d465a6a` (verified 2026-11-20).  
**Audit branch:** `docs/coop-connect-v2-contract-alignment`, created from that exact commit.  
**Frontend dependency:** `jolla3/tycoon-frontend` PR #4, branch `docs/superadmin-onboarding-and-history`, head `bd78e8867f2642d77333d1dfc1f408235e179bbf` (open, not merged at audit time).  
**Bank evidence:** User-supplied Co-op Connect APIs 2.0.0 guide and previously supplied AccountFullStatement 1.0.0 OpenAPI specification. Provider sandbox calls and production credentials were not tested.

> Read this document before changing the Co-op flow. It is deliberately an as-built review, not a generic OAuth tutorial. Every finding separates (1) what Co-op documents, (2) what Tycoon currently implements, (3) the incorrect or incomplete assumption, and (4) the exact correction required.

---

## 1. Executive result

The existing Tycoon connection ownership and encrypted credential-storage model is fundamentally correct and must be preserved. The primary mismatch is the Co-op authentication implementation and the customer credential contract:

- The frontend currently models Co-op credentials as `clientId`, `clientSecret`, `username`, `password`, and optional `scope`.
- The backend maps those fields into `CoopAuthService`.
- `CoopAuthService` rejects missing username/password/scope and always requests `grant_type=password`.
- Co-op Connect 2.0.0 separately documents a CK/SK-only `grant_type=client_credentials` token request.

The normal Tycoon connection flow must therefore become a Consumer Key + Consumer Secret application-token flow. Username/password must stop being mandatory customer inputs. Password grant is documented by Co-op, so it is not technically invalid; it is simply not established as necessary for Tycoon's account-enquiry resources and must not be selected unconditionally.

The audit also finds provider path mismatches, broken/manual FullStatement normalization, Account Validation error-classification gaps, unverified capability claims, an AccountNumber format conflict, lack of useful token reuse, and a callback credential leak into persisted raw payloads.

**No production or sandbox readiness is established by this documentation branch.** Co-op `operationalReady` must remain false until the external gates in section 13 are resolved and tested.

## 2. Non-negotiable identity distinction

This section exists because two unrelated identifiers have the same conventional name.

| Identifier | System | Type / source | Meaning |
|---|---|---|---|
| `BankConnection.clientId` | Tycoon | Mongo ObjectId from authenticated `req.clientId` / client context | Tycoon Client that owns the bank connection |
| `BankCredential.clientId` | Tycoon | Same Mongo ObjectId | Owner binding for encrypted Co-op credential material |
| Co-op OAuth `clientId` | Co-op | Consumer Key (CK) issued by Co-op / Developer Portal | OAuth application identifier used in Basic auth |
| Co-op OAuth `clientSecret` | Co-op | Consumer Secret (SK) issued by Co-op / Developer Portal | OAuth application secret used in Basic auth |

### What must remain unchanged

- `connectionController.create()` passes `req.clientId` to `connectionService.create()`. The request body must not choose the Tycoon owner.
- `BankConnection.clientId` and `BankCredential.clientId` remain Tycoon ObjectIds.
- `allocateCredentialsRef()`, AES-256-GCM associated data, `credentialsRef`, `credentialVersion`, client/provider ownership filters and staged reauthorization remain in place.
- Co-op CK/SK remain inside the connection's encrypted `credentialMaterial`, not in process-wide customer credential variables.
- Multiple Tycoon customers must not share connection token state.

### Required naming correction

The current frontend property `credentialMaterial.clientId` is the Co-op OAuth identifier, not the Tycoon customer ID. It is technically mapped correctly by the current factory, but it is an avoidable naming trap.

Change the UI/API boundary to:

```ts
interface CoopCredentialMaterial {
  consumerKey: string;       // Co-op CK
  consumerSecret: string;    // Co-op SK
}
```

The backend adapter may map these to `oauthClientId` / `oauthClientSecret` internally if that matches library conventions. Do not rename the Tycoon ownership field. Do not accept a Tycoon `clientId` inside credential material. Add a regression test proving a body field cannot override `req.clientId`.

## 3. What Co-op Connect 2.0.0 actually says about authentication

### 3.1 DCR is application setup, not normal Tycoon account linking

The guide documents a DCR endpoint:

```http
POST /client-registration/v0.17/register
Authorization: Basic base64(admin_username:admin_password)
Content-Type: application/json
```

The sample registration payload includes:

```json
{
  "callbackUrl": "www.google.lk",
  "clientName": "rest_api_devportal",
  "owner": "admin",
  "grantType": "client_credentials password refresh_token",
  "saasApp": true
}
```

The DCR response contains a `clientId` and `clientSecret`. These are the Consumer Key and Consumer Secret used by later OAuth token requests.

The registration administrator's username/password are credentials for DCR in the sample. They are not automatically the credentials a Tycoon landlord should enter when connecting a bank account. The customer has already been asked for the generated keys. Do not add DCR registration to the customer connection flow and do not ask customers for the DCR administrator credentials.

`saasApp: true` is present in the DCR example. It does not, by itself, establish the precise onboarding/authorization process for every customer's underlying bank account.

### 3.2 Co-op documents more than one grant

The guide explicitly describes a password-grant example and says another grant may be selected. The same guide then shows CK/SK-only client-credentials examples.

| Grant | Documented inputs | What Tycoon should do |
|---|---|---|
| `client_credentials` | CK/SK in Basic auth; PHP example sends `grant_type=client_credentials` form field; no username/password | Default for the normal key-only Tycoon connection |
| `password` | CK/SK Basic auth plus username, password and scope | Do not require or call by default; allow only if a particular API resource is documented to require an application-user token |
| `refresh_token` | Listed among DCR grant types; password-grant sample returns a refresh token | Do not assume client_credentials issues a refresh token or that refresh behavior is identical; verify before implementing |

The error list documents both application and user access-token types. Error `900905` occurs when an application token is used where a user token is required. Therefore token type must be selected per resource authorization, not assumed to be global.

**Important correction:** Password grant is not invalid according to Co-op. The actual defect is that Tycoon made it the only allowed grant and made username/password mandatory despite having a documented CK/SK-only application-token flow. Remove that mandatory dependency. Do not replace one unsupported universal assumption with another: verify the token type required by each resource.

### 3.3 Canonical client-credentials request

The PHP HOWTO provides the explicit request:

```http
POST https://developer.co-opbank.co.ke:8243/token
Authorization: Basic base64(CK:SK)
Content-Type: application/x-www-form-urlencoded

grant_type=client_credentials
```

The Java HOWTO instead shows GET without the explicit grant body. This is an inconsistency in the supplied guide. The implementation should use the explicit POST/form example because it carries the actual grant parameter, then verify it against Co-op sandbox.

The docs' sample `-k` and `CURLOPT_SSL_VERIFYPEER=false` disable TLS verification. These are not acceptable production implementation settings. Keep normal TLS certificate and hostname verification enabled.

### 3.4 Scope must not be guessed

Co-op states scopes control access and says each resource's authorization section identifies the relevant scope. The generic password example shows `apim:subscribe apim:api_key`; this is not proof that those are the scopes for Account Validation, Account Transactions or Full Statement.

The PHP `client_credentials` example does not include a scope field. This does not prove every API call is scope-free. It means the token request and resource authorization need to be validated against the applicable API definitions.

Required correction:

1. Remove the free-form optional Scope field from the normal customer credential form unless Co-op explicitly makes it customer-specific.
2. Do not default to `default`, `apim:subscribe`, `apim:api_key`, or any invented string.
3. Obtain exact scopes and required token type for each resource from Co-op's OAuth2 Security and resource authorization sections.
4. Put reviewed scope selection in provider/resource configuration. If scopes differ per resource, represent that difference rather than pretending one generic scope applies to every operation.
5. Add a sandbox check for missing scope and wrong token type; classify `900910` and `900905` distinctly.

## 4. Current Tycoon implementation: exact as-built behavior

The following is the current backend `main` implementation at the audit baseline, not an intended future design.

| Current file | Observed behavior | Gap / change |
|---|---|---|
| `src/models/BankConnection.js` | `clientId` is a required Tycoon Client ObjectId; credential reference/version are stored separately | Correct. Preserve; do not confuse with Co-op OAuth client ID |
| `src/models/BankCredential.js` | Credential records are AES-256-GCM envelopes; owner/provider/version are immutable | Correct. Preserve |
| `src/services/banking/secretsManager.js` | Encryption AAD binds reference, Tycoon client ID, provider and credential version | Correct. Preserve |
| `src/services/connection.service.js` | Accepts generic `credentialMaterial`, stores it encrypted, constructs adapter and authenticates; create marks connection active after token acquisition | Retain lifecycle, add strict provider-specific credential validation; clarify active means OAuth connection authenticated, not every bank account validated |
| `src/services/banking/bank.factory.js` | Maps `credentialContext.clientId/clientSecret/username/password/scope` into the Co-op adapter; passes connection ID/version | Change provider credential shape and grant context; keep Tycoon ownership supplied separately |
| `src/services/banking/providers/coop/coop.auth.js` | Requires all five fields; only sends password grant; requires scope; posts to `${baseUrl}/token`; caches token on service instance; defaults missing `expires_in` to 3600 | Replace default with CK/SK client_credentials; no mandatory user/password; no guessed scope/TTL; introduce connection/version keyed token coordination |
| `src/services/banking/providers/coop/coop.provider.js` | Uses `/AccountValidation`, `/AccountTransactions`, `/AccountFullStatement`, `/AccountBalance`; `validateAccount()` returns `valid: true` after a generic success response | Replace documented paths; type Account Validation result; disable unsupported Balance path |
| `src/services/banking/providers/coop/coop.client.js` | POSTs JSON and accepts MessageCode 0; maps every non-zero code into a generic provider-unavailable error; logs raw HTTP error response data | Add typed provider error classification and payload redaction |
| `src/services/banking/providers/coop/coop.schemas.js` | Shared account number schema requires exactly 14 characters; AccountTransactions NoOfTransactions is a positive number without documented max | Use resource-specific confirmed account-number rules; send correct request serialization and max |
| `src/services/banking/providers/coop/coop.mapper.js` | Generic polled mapper expects Amount and TransactionId/TransactionID/RefNo; separate FullStatement mapper exists; webhook mapper stores raw body including Basic | Dedicated resource mappers; ensure FullStatement uses its mapper; redact callback Basic |
| `src/services/banking/providers/coop/coop.syncStrategy.js` | AccountTransactions polling disabled; scheduled FullStatement path has a remapping workaround | Retain polling gate; remove workaround once provider returns canonical FullStatement items |
| `src/services/bank.service.js` | Account is written only after validation succeeds by exception path, but it does not explicitly assert returned `valid === true` | Require a typed valid result; no activation on false, missing or malformed validation result |
| `src/config/environment.js` | Declares optional `COOP_CLIENT_ID/SECRET/USERNAME/PASSWORD/SCOPE`; `COOP_BASE_URL` and `COOP_INS_BASIC_SECRET` also exist | Outbound customer auth is injected from BankCredential, not these customer env vars. Audit usages before removing stale declarations; never restore env fallback. Keep platform callback secret distinct |
| Frontend `src/lib/api/bank-connections.ts` on `main` | `CoopCredentialMaterial` requires `clientId`, `clientSecret`, `username`, `password`, and allows scope | Rename to consumerKey/consumerSecret; remove mandatory username/password and customer-supplied generic scope |
| Frontend `src/features/banking/banking-setup-panel.tsx` in PR #4 review branch | Credential dialog shows Client ID, Client secret, Username, Password, optional Scope; its validity gate requires the four first fields | Change the dialog to CK/SK only, with precise labels; clear input on success/close and never echo credentials |
| Frontend `main` | The API type exists, while the reusable Superadmin BankingSetupPanel is part of open frontend PR #4 | Update the in-review component before merging; do not claim its UI is already on main |

### 4.1 Existing connection lifecycle that is correct

```text
Authenticated Tycoon request
   |
   | req.clientId comes from client context
   v
connectionService.create(Tycoon clientId, credentialMaterial)
   |
   +--> allocate credentialsRef using Tycoon owner/provider
   +--> AES-256-GCM BankCredential write
   +--> BankConnection stores Tycoon clientId + credentialsRef + version
   +--> decrypt exact owner/version record in process memory
   +--> construct provider adapter and authenticate
   +--> set connection auth status
```

Keep this. Only change the provider-specific credential shape and the Co-op OAuth request. A Co-op Consumer Key must never become the `BankConnection.clientId`.

### 4.2 Clarify what an active connection means

Connection creation currently tests OAuth authentication. Account registration separately calls Account Validation before saving a connected/validated BankAccount. Preserve this distinction:

- `BankConnection.status=active`: the configured Co-op OAuth connection can obtain an accepted token.
- `BankAccount.validationStatus=validated`: Co-op Account Validation explicitly confirmed that specific account.
- An active connection does not prove every account is authorized. Co-op error `-8` specifically describes account authorization failure.

Do not make connection success imply account authorization or successful statement access.

## 5. Required authentication and credential changes

### P0 - frontend request contract

Files:
- Frontend `src/lib/api/bank-connections.ts`
- Frontend `src/features/banking/banking-setup-panel.tsx` on PR #4 review branch
- Backend `src/utils/validators.js`
- Backend `src/services/connection.service.js`

Change:

1. Customer create/reauthorize form collects `consumerKey` and `consumerSecret` only.
2. Label the inputs `Co-op Consumer Key (CK)` and `Co-op Consumer Secret (SK)`. Do not label the first one merely `Client ID`, because the product already has a Tycoon Client ID.
3. Remove Username and Password from the normal form and validity gate.
4. Remove generic Scope from the normal customer form until Co-op confirms the exact resource scopes and who configures them.
5. Replace `z.record(z.any())` for Co-op credentials with a strict provider-specific schema. Reject unknown keys rather than silently persisting unsupported credential material.
6. Keep secrets request-only in the frontend. Do not add them to React Query cache, local storage, IndexedDB, URL state, analytics or logs.
7. Preserve the selected Tycoon customer context (including Superadmin explicit client selection) as the owner. Never put a client owner ID into the credential object.

Acceptance:
- CK/SK only passes validation and reaches the backend.
- Missing CK or SK fails before BankCredential is written.
- username/password are not required, rendered, persisted or logged in normal flow.
- request body cannot override Tycoon owner.
- frontend error handling never prints the submitted values.

### P0 - backend Co-op authentication

Files:
- `src/services/banking/providers/coop/coop.auth.js`
- `src/services/banking/providers/coop/coop.provider.js`
- `src/services/banking/bank.factory.js`
- `src/services/connection.service.js`

Change:

1. Accept a distinct CK/SK credential shape and map it explicitly to the OAuth Basic pair.
2. Implement form-urlencoded `grant_type=client_credentials` as the default token request.
3. Do not require username/password or scope for the client_credentials request itself.
4. Do not fall back to password grant after an app-token failure. Wrong token type, missing subscription and insufficient scope need explicit diagnosis, not a blind different grant.
5. Keep password-grant support only as an explicit, separately configured mode after resource-level evidence confirms it. Such support must not make username/password mandatory for all customers or ask for a consumer's normal digital-banking login.
6. Separate token URL from resource API base/path configuration.
7. Validate token response structure: non-empty access_token, expected Bearer token type, and usable expiry metadata. Do not silently substitute 3600 when `expires_in` is absent. The 3600 value in the supplied guide is an example response for its password-grant request, not a verified client_credentials TTL.
8. If a valid client_credentials response does not contain a refresh token, reacquire an application token on expiry. Use refresh-token flow only after Co-op confirms client_credentials refresh behavior.
9. Do not log CK, SK, Basic header, username/password, access token, refresh token or raw token response.
10. Record actual token expiry in `BankConnection.authMeta.tokenExpiresAt` when available.

Acceptance:
- Axios request is POST with Basic CK:SK and `application/x-www-form-urlencoded` body `grant_type=client_credentials`.
- No username/password is transmitted.
- A missing or malformed token response fails closed.
- Client credentials are read only from the matching BankCredential reference, Tycoon client owner, provider and credential version.
- A failed staged reauthorization preserves the old credential version and live connection.

### P1 - token cache behavior

Current `CoopAuthService` caches the token on its own instance. However, `connectionService.getAdapterForConnection()` constructs a fresh adapter on each normal request. Therefore the instance cache is discarded between account validation, manual statement, sync and other API calls.

Add a token coordinator/cache whose lookup identity includes at least:
- Tycoon `BankConnection._id`
- `credentialVersion`
- OAuth grant type
- effective scope/resource token context

Requirements:
- Never key by provider name alone.
- Never share token state across two Tycoon customers or two independent connections.
- Reauthorization invalidates only the matching connection/version.
- Coalesce concurrent token-acquisition calls for the same key to avoid token stampedes.
- Do not store decrypted CK/SK in Redis or another shared cache.
- Keep access tokens out of logs and API DTOs.
- Define process-restart and multi-instance behavior explicitly. A process-local cache is acceptable as a first implementation if its per-process reacquisition behavior is documented; do not add a distributed token store without an explicit security review.

Tests must prove connection A and B do not share cached tokens, and rotating A's credentials does not invalidate B.

## 6. Endpoint and transport corrections

Current `COOP_BASE_URL` is used for both `/token` and all API calls. Current resource suffixes do not match the documented routes. Replace the implicit base-path convention with explicit token URL and resource paths/URLs per environment.

| Capability | Current code route | Co-op route supplied | Required action |
|---|---|---|---|
| Token | `${baseUrl}/token` | Developer gateway example `/token` | Add explicit `COOP_TOKEN_URL`; verify POST client_credentials in sandbox |
| Account Validation | `/AccountValidation` | `/Enquiry/Validation/Account/1.0.0` | Correct path and response contract |
| Account Transactions | `/AccountTransactions` | `/Enquiry/AccountTransactions/1.0.0/Account` | Correct path; keep operational polling disabled until identity/mapping verified |
| Full Statement | `/AccountFullStatement` | FullStatement OpenAPI versioned path/server | Correct URL using the OpenAPI server and environment configuration |
| Mini Statement | Not implemented | `/Enquiry/MiniStatement/Account/1.0.0` | Do not implement as a transaction feed; response sample shows summary/balances only |
| Balance | `/AccountBalance` | No matching path provided | Disable capability and obtain exact API definition |

The Developer Portal guide uses `https://developer.co-opbank.co.ke:8243` for its samples. The prior FullStatement OpenAPI specifies a separate sandbox hostname and a versioned service path. Configure exact URLs per sandbox/production environment and per resource as needed. Do not invent production URLs or assume that the developer portal hostname is the production gateway.

Do not set TLS verification to false. The bank's sample cURL/PHP snippets disable TLS verification for illustration; Tycoon runtime must retain certificate verification.

## 7. Account Validation: fix result semantics

### Co-op documented behavior

Route: `POST /Enquiry/Validation/Account/1.0.0`.

Request:
```json
{
  "MessageReference": "40ca18c6765086089a1",
  "AccountNumber": "36001873000"
}
```

Response:
- MessageCode `0`: `VALID ACCOUNT NUMBER`
- MessageCode `-1`: `INVALID ACCOUNT NUMBER`

The guide gives multiple test account numbers returning 0 and says any other account returns -1.

### Current behavior

- `coopPost()` treats MessageCode 0 as success and all non-zero MessageCodes as generic `BankProviderUnavailable`.
- `validateAccount()` returns `{ valid: true, raw: data }` for any response accepted by `coopPost()`.
- `bankService.connectAccount()` awaits `adapter.validateAccount()` but does not explicitly assert that the returned object contains `valid === true`.

The fail-closed write ordering in `bank.service.js` is correct, but the response type and error classification are too weak. There is a second, caller-side defect: the inner validation catch currently wraps **every** validation exception in `Errors.InvalidRequest`. That incorrectly turns token failures, insufficient scopes, timeouts and upstream outages into a customer-input error. Only Co-op MessageCode `-1` is an invalid-account rejection. Authentication, account-authorization, scope, subscription, transport and provider errors must retain their typed upstream categories while still preventing any account write.

### Required change

- Give Account Validation a specific result contract. MessageCode 0 returns `{ valid: true }`; MessageCode -1 returns a typed invalid-account result/error, not a generic upstream outage.
- Any malformed response, missing MessageCode, unrecognized code, HTTP failure, invalid token, missing subscription or account authorization failure must not activate/update the account.
- `connectAccount()` must explicitly require `result.valid === true`; false, undefined or malformed output is rejected before persistence.
- Change the inner catch in `bank.service.connectAccount()` so it preserves typed `AppError` categories. Map only the explicit invalid-account result (`-1`) to the account-input validation response. Do not turn 401/403/408/429/5xx provider failures into `INVALID_REQUEST`. All such failures still leave the existing/new BankAccount unchanged.
- Do not populate accountName from a claimed bank response. The Account Validation sample has no AccountName. The name currently entered by the customer is customer-provided and must not be labelled bank-verified.
- Keep the existing account validation fail-closed and compare-and-set reconnect logic.

Tests: MessageCode 0, -1, missing MessageCode, unknown code, HTTP failure, token error, account authorization `-8`, and adapter returning `{ valid:false }` or no valid flag. Assert that only `-1` maps to invalid-account input; provider/auth/network errors preserve their status/category and never mutate the account.

## 8. Account number format contradiction

Current `CoopAccountNumber` schema enforces exactly 14 characters for all account operations. The supplied guide shows 11-digit Account Validation test accounts (for example `36001873000`) and also shows 14-digit values in other enquiry examples. The FullStatement OpenAPI also declares 14 characters while an example conflicts.

Do not silently change the shared rule to 11 or 14 based on one example. Ask Co-op to confirm the accepted account-number format for Account Validation, Account Transactions, FullStatement, MiniStatement and Balance independently. Implement resource-specific schemas if the bank confirms different formats. Preserve leading zeros and store account numbers as strings.

Until confirmation:
- Record this as a provider contract blocker.
- Do not reject the bank's own documented test account before it can be used in a controlled validation test without an explicit test-only path.
- Do not relax production account-number validation globally.

## 9. FullStatement mapper defect

### Documented FullStatement item

The supplied FullStatement OpenAPI defines transaction items with:
- `TransactionId`
- `TransactionDate`
- `ValueDate`
- `TransactionType` (`C` credit / `D` debit)
- `TransactionReference`
- `CreditAmount`
- `DebitAmount`
- `RunningClearedBalance`
- `RunningBookBalance`
- `Narration` and other descriptive fields

### Current mismatch

`CoopBankProvider.getFullStatement()` currently maps each item with `mapCoopPolledTransaction()`. That generic mapper looks for `Amount`, `EventType`, and generic reference fields. For the documented FullStatement item, it does not correctly:
- populate amount from CreditAmount/DebitAmount;
- normalize C/D to CREDIT/DEBIT;
- reliably use TransactionId;
- preserve the documented fields according to the FullStatement contract.

A separate `mapCoopFullStatementItem()` already exists. The scheduled strategy has a workaround that inspects `rawPayload` and remaps FullStatement-shaped items. Manual statement import calls `getFullStatement()` directly and bypasses that scheduled workaround. The two entry paths therefore do not share the same correctness.

### Required change

- Make `getFullStatement()` use `mapCoopFullStatementItem` directly on the provider response.
- Return the canonical normalized candidate from the adapter; do not require callers to remap an already mapped object.
- Remove the scheduled-path rawPayload remapping workaround after tests prove equivalence.
- Preserve TransactionDate as the G3 transaction date and ValueDate separately.
- Reject or quarantine missing/empty TransactionId; do not fabricate identity from narration/date/amount.
- Keep direction explicit. If both credit and debit amounts are positive, neither is positive, or TransactionType contradicts the amounts, reject/quarantine rather than default.
- Preserve the current unique index until Co-op confirms TransactionId uniqueness scope. Do not change G3 or create a second ingestion path.

Tests must exercise the same fixture through both manual statement import and scheduled FullStatement synchronization and assert identical normalized fields and idempotency behavior.

## 10. AccountTransactions polling: documented route, incomplete identity

### Documented request and response

Route: `POST /Enquiry/AccountTransactions/1.0.0/Account`.

The request sample includes `MessageReference`, `AccountNumber`, and `NoOfTransactions` as a string. The documented limit example says values lower than the configured minimum or greater than 500 are rejected; the limits are configurable.

The supplied response item includes:
- `TransactionDate` and `ValueDate`
- `TransactionType` C/D
- `TransactionReference`
- `CreditAmount` and `DebitAmount`
- `RunningClearedBalance` and `RunningBookBalance`
- `Narration`, `ServicePoint`

The example does not include `TransactionId`.

### Current mismatch

`mapCoopPolledTransaction()` looks for `TransactionId`, `TransactionID` or `RefNo`; amount `Amount`; direction `EventType` or `TransactionType`. Against the supplied sample:
- the transaction ID would be empty;
- amount would be null because only CreditAmount/DebitAmount are shown;
- direction would be the raw value `C`, which violates normalized `CREDIT|DEBIT`;
- TransactionReference is not proved to be a globally unique transaction identity.

Polling is currently disabled in the provider capability profile. Preserve that gate.

### Required change before enabling

- Implement a dedicated AccountTransactions item mapper using the documented credit/debit fields.
- Confirm whether the provider supplies a stable unique ID in the complete resource schema/runtime response. Do not silently treat TransactionReference as a unique providerTransactionId without proof.
- Parse/validate NoOfTransactions using the provider's documented serialization and confirmed minimum/maximum (maximum example 500; do not assume the configured minimum).
- Preserve TransactionDate and ValueDate separately.
- Only enable polling after sandbox fixtures, identity scope, pagination/order behavior, and checkpoint semantics are verified.
- Do not map the account enquiry path to a funds-transfer operation; the sample is an enquiry response, notwithstanding the source page's confusing prose label.

## 11. MiniStatement and Balance capability decisions

### MiniStatement

The guide documents `POST /Enquiry/MiniStatement/Account/1.0.0`. Its supplied response example has AccountName, ProductName, Currency, ClearedBalance, BookedBalance, BlockedBalance, AvailableBalance, ArrearsAmount and branch/limit information. It does not show a `Transactions` array or transaction items.

Therefore:
- Do not call it a transaction feed.
- Do not substitute it for AccountTransactions or FullStatement.
- Do not claim it implements Balance unless Co-op confirms the resource's actual purpose and response contract.
- If product needs a mini-statement capability later, add it as a separately named feature only after the complete API contract is reviewed.

### Balance

The current provider has `getAccountBalance()` and constructs the undocumented route `/AccountBalance`. The registry currently marks `balance: true`, while readiness already says the balance contract is unverified.

Required:
- Set Balance capability/entitlement false and do not expose the operation until the exact Balance Enquiry API path, request, response, auth type, scope and account authorization requirements are documented.
- Do not infer the Balance path from the MiniStatement response or generic Co-op product descriptions.
- Add response and currency handling only from a verified resource schema.

## 12. Inbound SendTransactionINS webhook: separate credential and leakage

Outbound Co-op OAuth CK/SK and inbound webhook verification are different channels.

Current architecture uses platform environment `COOP_INS_BASIC_SECRET` for the inbound INS Basic endpoint credential. It is passed to the webhook verifier separately from connection-scoped outbound OAuth credentials. Preserve that separation unless Co-op provides new evidence of per-subscription credentials.

Current webhook mapper stores `rawPayload: raw`. The schema permits a `Basic` body property, and the verifier accepts a Basic header or body. If Co-op sends the credential in the body, it can be persisted in `BankTransaction.rawPayload`. Callback quarantine also receives request bodies on error paths.

Required:
- Redact/remove `Basic` before rawPayload persistence, callback quarantine, structured logs and diagnostic output.
- Never send `COOP_INS_BASIC_SECRET` through the customer Co-op credential form or store it in BankCredential as though it were CK/SK.
- The current `registerTransactionNotification()` is a no-op. The supplied guide does not document a REST endpoint for callback registration. Keep this manual/portal configuration unimplemented until Co-op confirms the actual workflow.
- Do not invent a webhook signature algorithm, callback retry policy or HTTP acknowledgement guarantee.
- Keep the webhook capability gated; a platform lab override is not production readiness.

Tests must inject the secret in both header and body, prove verification still works, and prove no persisted transaction/quarantine/log payload contains it.

## 13. Error-code mapping and safe retry behavior

The guide's message/error table is part of the integration contract. The current `coopPost()` collapses all non-zero MessageCode responses to `BankProviderUnavailable` and logs raw HTTP error response data. This erases distinctions the user needs to correct configuration and can leak account or provider data.

Implement typed categories at the adapter boundary:

| Code | Bank meaning | Tycoon handling |
|---|---|---|
| HTTP 400 / `-2` | Invalid/missing request parameter | Contract/input error; no retry |
| HTTP 408 / `-4` | Request timed out/backend unavailable | Transient provider error; retry only through safe, bounded operation policy |
| HTTP 400 / `-6` | NoOfTransactions outside configured limit | Input/configuration error |
| HTTP 401 / `-7` | Authorization failure | Token/auth failure |
| HTTP 401 / `-8` | Account authorization failure | Account not authorized for API consumer; not an invalid OAuth password |
| HTTP 400 / `-11` | Message/reference too long | Request validation error |
| HTTP 503 / `700700` | API blocked | Capability temporarily unavailable |
| HTTP 429 / `900800` | Throttled request | Rate-limit state; bounded backoff, not hot loop |
| HTTP 503 / `900801` | Hard limit exceeded | Stop or defer calls; no retry storm |
| HTTP 401 / `900901` | Invalid credentials/older token after renewal | Token lifecycle issue; at most one controlled reacquisition for safe read-only enquiries |
| HTTP 401 / `900902` | Missing credentials | Header/token construction defect |
| HTTP 401 / `900905` | Wrong token type | Resource grant configuration defect; do not retry same token type |
| HTTP 403 / `900906` | Resource not found | Wrong path/version or unpublished resource |
| HTTP 401 / `900907` | API user blocked | Provider-side account/API user block |
| HTTP 403 / `900908` | Resource forbidden/unsubscribed | Portal API subscription/approval issue |
| HTTP 401 / `900909` | Subscription inactive | Subscription lifecycle issue |
| HTTP 403 / `900910` | Insufficient scope | Scope/authorization configuration issue |
| HTTP 400 / `102511` | Incomplete payload | Request schema error |

Retry constraints:
- Enquiry calls are read operations, but still use bounded retries and preserve request reference/correlation semantics where the provider requires.
- Do not retry a rejected invalid account, wrong token type, missing scope, inactive subscription or blocked API as if transient.
- Do not introduce blind retries for transaction-creating APIs; they are outside this current enquiry scope.
- Respect 429/hard limit responses; do not poll harder.
- Logs should contain safe metadata only: operation identifier, HTTP status, MessageCode, MessageReference/correlation where safe, and connection ID. Never log credentials, token, account number, raw bank body or raw HTTP response data.

## 14. Token response lifecycle and cache

Current auth code:
- keeps a token on one `CoopAuthService` instance;
- stores `refresh_token` if returned but never uses it;
- falls back to 3600 seconds if `expires_in` is absent;
- logs provider response errors without a full response contract check.

Correct it:
- validate token response fields and token type;
- use the actual `expires_in` for client_credentials when supplied and verified;
- do not inherit the password-grant example's TTL or refresh response by assumption;
- if token expires, use the supported application grant again unless refresh-token support for this grant is proven;
- use connection/version keyed token coordination because adapters are recreated on each service call;
- ensure in-flight token requests are coalesced for a given connection/version/scope;
- do not expose tokens in `authMeta`, DTOs, logs or frontend.

The existing `BankConnection.authMeta.tokenExpiresAt` field should contain a real expiry timestamp, not remain null after successful auth when the provider supplies expiry.

## 15. Entitlements, connection health and truthful capability claims

Current registry includes:
- `polling: false` (correctly gated);
- `statementImport: true` (FullStatement contract supplied, but sandbox still not verified);
- `balance: true` (not supported by an exact resource contract in the supplied evidence);
- `webhook: true` (callback contract and sandbox still not verified).

`entitlementsFromCapabilities()` derives account flags directly from these booleans. Therefore a capability can be stamped onto an account even if its detailed readiness profile says contract verification is false.

Required:
- Make capability implementation, contract verification, account entitlement and operational readiness distinct states.
- Set Balance entitlement false until its API contract is documented and verified.
- Do not grant webhook entitlement for production while callback readiness/auth/subscription is unverified.
- Preserve polling false.
- FullStatement statement entitlement may be used only with the documented request/item mapping and the existing operational/lab gates. A completed implementation does not establish sandbox success.
- Keep global Co-op `operationalReady=false` until required provider and runtime gates are closed.

## 16. Environment configuration cleanup

Current `src/config/environment.js` declares optional `COOP_CLIENT_ID`, `COOP_CLIENT_SECRET`, `COOP_USERNAME`, `COOP_PASSWORD` and `COOP_SCOPE`. The current customer adapter factory injects credential material from the connection-scoped BankCredential and does not fall back to these environment values. `COOP_BASE_URL` and `COOP_INS_BASIC_SECRET` serve separate platform purposes.

Required:
- Keep the no-global-customer-credential-fallback invariant.
- Search all source, scripts, tests, deployment config and documentation for each old variable before removal.
- Remove or rename unused outbound credential environment variables only after that reference audit; do not remove `COOP_INS_BASIC_SECRET` as part of outbound OAuth changes.
- Introduce explicit token/API environment URL configuration; do not put customer keys in process environment.
- Keep encryption-key configuration separate from the Co-op Consumer Secret.

## 17. Requirement-to-file change register

| ID | Priority | File(s) | Required change |
|---|---|---|---|
| C2-001 | P0 | Frontend `src/lib/api/bank-connections.ts` | Rename credential fields to CK/SK (`consumerKey`, `consumerSecret`); remove username/password/scope from normal credentials type |
| C2-002 | P0 | Frontend `src/features/banking/banking-setup-panel.tsx` on PR #4 branch | Show CK/SK labels only; require only those two; retain safe secret lifecycle |
| C2-003 | P0 | Backend `src/utils/validators.js` | Strict provider-specific credential schema; reject unknown fields and missing CK/SK |
| C2-004 | P0 | Backend `src/services/connection.service.js` | Preserve Tycoon owner context; validate and stage exact Co-op credential shape |
| C2-005 | P0 | Backend `src/services/banking/bank.factory.js` | Map connection's Co-op consumer keys to adapter without confusing Tycoon owner |
| C2-006 | P0 | Backend `src/services/banking/providers/coop/coop.auth.js` | Default client_credentials token POST, no mandatory username/password, strict token response handling |
| C2-007 | P0 | Backend `src/config/environment.js`, Co-op transport | Separate token URL from resource API URLs; no guessed production host |
| C2-008 | P0 | Backend `src/services/banking/providers/coop/coop.provider.js` | Correct Account Validation, AccountTransactions and FullStatement paths; keep Balance gated |
| C2-009 | P0 | Backend `src/services/banking/providers/coop/coop.schemas.js` | Resource-specific request schemas, NoOfTransactions serialization/limit and unresolved account-number discrepancy |
| C2-010 | P0 | Backend `src/services/banking/providers/coop/coop.client.js` | Preserve typed HTTP/MessageCode errors; redact response body from logs |
| C2-011 | P0 | Backend `src/services/banking/providers/coop/coop.mapper.js` | Use documented FullStatement mapper; add separate AccountTransactions mapper only after ID semantics; redact INS Basic |
| C2-012 | P0 | Backend `src/services/banking/providers/coop/coop.syncStrategy.js` | Remove scheduled-only remapping workaround once provider returns canonical items; keep polling disabled |
| C2-013 | P0 | Backend `src/services/bank.service.js` | Require explicit `valid === true` before account persistence; map only the explicit invalid-account response to client input error and preserve typed provider/auth/transport failures |
| C2-014 | P0 | Backend `src/routes/webhook.routes.js`, callback quarantine/ingestion | Ensure Basic secret never reaches persisted/quarantined/logged raw body |
| C2-015 | P1 | Auth token coordinator and `src/services/connection.service.js` | Reuse tokens by connection/version/grant/scope; invalidate on reauthorization |
| C2-016 | P1 | Backend `src/services/banking/bank.factory.js`, readiness and entitlement mapping | Do not assign unverified Balance/webhook capabilities |
| C2-017 | P1 | Backend `src/models/BankConnection.js` / `connection.service.js` | Populate auth expiry metadata accurately; preserve existing credential reference/version |
| C2-018 | P1 | Tests under `tests/unit` and `tests/integration` | Add all test cases in section 18, including tenant isolation and G3 regression |
| C2-019 | P1 | Provider docs / deployment config | Audit/remove stale `COOP_CLIENT_*` / username/password / generic scope env names only after complete reference search |
| C2-020 | P1 | Co-op API configuration | Document resource-specific grant type, scope and URL configuration; never use defaults without evidence |
| C2-021 | P0 | Backend `src/services/bank.service.js` | Preserve typed provider errors from Account Validation; do not convert token, scope, timeout, throttling or upstream failures into `INVALID_REQUEST` |
| C2-022 | P0 | Backend `src/services/banking/bankSync.service.js` | Replace generic poll-OR-statement entitlement gate with strategy-specific authorization; FullStatement requires statement, AccountTransactions requires poll |
| C2-023 | P0 | Backend `src/services/connection.service.js`, `src/services/bank.service.js`, `src/routes/webhook.routes.js` | Enforce current active parent BankConnection for every account operation; prevent webhook ingestion after parent disconnect |
| C2-024 | P0 | Backend `src/services/bank.service.js` | Re-check parent connection after FullStatement response and before manual statement ingestion; apply provider readiness/lab gate to direct statement import |
| C2-025 | P1 | Backend bank DTO/controller and Frontend BankingSetupPanel | Expose/derive effective parent-connection state separately from account link state; disable UI operations on missing/inactive parent |
| C2-026 | P1 | Backend `src/services/connection.service.js`, API error mapper, frontend connection panel | Preserve create status=failed semantics for HTTP 201 and expose safe typed reauthorization failure categories |

## 18. Required test matrix and completion criteria

### Authentication and ownership
- Client-credentials POST has Basic base64 of CK:SK and exactly the expected form-urlencoded grant.
- CK/SK are the only required customer fields for normal create and reauthorize.
- No username/password sent by the normal connection workflow.
- Password grant is never silently selected as a fallback.
- Resource-specific user token path is used only with explicit configuration and tests.
- Missing/invalid CK/SK fails without activating the connection.
- Connection credentials persist encrypted and are bound to the Tycoon owner/provider/version.
- A body-supplied Tycoon `clientId` cannot change credential ownership.
- Two Tycoon connections cannot read each other's credential material or token.
- Credential rotation tests staged auth, promotion, old-version invalidation and failed-stage preservation.

### Token lifecycle
- Valid response stores expiry; malformed token response fails closed.
- No assumed 3600-second fallback.
- Cache key includes connection ID, credential version, grant and scope context.
- Reauthorization invalidates the matching cache entry only.
- Concurrent requests for one connection do not stampede token acquisition.
- Tokens and credential values are absent from logs, API responses and test snapshots.

### API routing and response handling
- Exact paths are asserted for each documented operation.
- Token and API URL configuration can differ.
- TLS verification remains enabled.
- Account Validation MessageCode 0 and -1 have separate outcomes.
- Account authorization `-8`, invalid token `-7/-7`, wrong token type `900905`, missing scope `900910`, missing subscription `900908`, throttle `900800`, hard throttle `900801`, timeout `-4` and invalid payload `-2` are not collapsed.
- Account number formats are tested per endpoint after confirmation.
- Account Validation cannot activate an account if result is false, absent or malformed.

### Statement/polling/ingestion
- FullStatement manual and scheduled paths produce identical normalized items.
- Credit and debit amounts, C/D direction, transaction date and value date are correct.
- Missing or contradictory transaction identity/direction is rejected or quarantined.
- Duplicate statement re-import remains idempotent under the existing transaction unique index.
- AccountTransactions mapping has fixture coverage but remains operationally disabled until stable transaction identity and ordering semantics are verified.
- No G3 payment, allocation, rent charge or ledger path is changed; run existing G3 reconciliation regressions.

### Webhook/security/capabilities
- INS Basic is never in BankTransaction rawPayload, quarantine documents, API DTOs or logs.
- Callback credential is never requested on the outbound connection form.
- Balance, MiniStatement transaction-feed and polling features are not advertised/entitled without contract evidence.
- Co-op overall readiness remains false until sandbox and authorization gates are closed.

### Reporting rule
For every test run, report the exact command and actual result. Mark Mongo/replica-set, browser, provider sandbox, deployment and production verification NOT RUN when not executed. A local mocked HTTP test does not prove Co-op sandbox success.

## 19. External questions still requiring Co-op confirmation

The supplied guide answers the client_credentials-versus-password question at the grant level, but the following are still open. Do not write assumptions into code to fill these gaps.

1. For Account Validation, Account Transactions, FullStatement, MiniStatement and Balance Enquiry individually, is an application token accepted, or is an application-user token required? Provide exact OAuth2 Security configuration.
2. What are the exact scope strings required by each resource and which API subscriptions/approvals must be active?
3. What are the production DCR, token and API resource URLs? Confirm the sandbox token host and whether FullStatement uses the separate OpenAPI host.
4. What is the client_credentials token response contract, expiry and refresh behavior? Does it return `expires_in` and/or a refresh token?
5. Is the AccountTransactions `TransactionReference` stable and unique for deduplication? If not, which field is the canonical transaction ID and what is its uniqueness scope?
6. Confirm accepted account-number formats per endpoint. Why do Account Validation test accounts show 11 digits while FullStatement/other examples show 14?
7. Does MiniStatement return transactions in the complete response, or only the account summary/balance fields shown in the sample?
8. Provide the exact Balance Enquiry resource path, request schema, response schema, token type and scope.
9. How is SendTransactionINS configured/subscribed? Is the Basic credential expected only in a header, in the body, or both? What are callback retry and acknowledgement requirements?
10. How does Co-op authorize a customer's account to a SaaS application, and what is the correct handling for `-8` account authorization failure? Does each Tycoon client/customer need a separate app credential registration or is a shared SaaS application registration explicitly supported for this account model?

Support contact supplied by Co-op: `openbankingcustomersupport@co-opbank.co.ke`.

## 20. Implementation order

1. Correct CK/SK form and strict backend credential schema while preserving Tycoon owner identity.
2. Implement client_credentials and response validation; separate token URL configuration.
3. Correct Account Validation route and typed 0/-1 handling; make the caller require `valid === true`.
4. Correct FullStatement resource route and make one canonical mapper serve manual and scheduled paths.
5. Redact INS Basic from all persisted/logged bodies.
6. Correct safe error classification and operational capability/entitlement mapping.
7. Add connection/version keyed token coordination and expiry metadata.
8. Add AccountTransactions mapper and enable polling only after unique-ID and provider behavior verification.
9. Add MiniStatement/Balance only after their resource contracts are confirmed.
10. Run unit, HTTP integration, disposable replica-set integration, G3 regression and frontend responsive tests; separately verify against Co-op sandbox.
11. Update PRD, architecture, architecture-summary, CONTRACT_EVIDENCE and frontend PRD/architecture after code changes. This audit is a plan and evidence ledger; it is not proof that fixes have landed.

## 21. Explicit non-goals and preservation rules

- Do not replace the Tycoon bank-connection or encrypted credential ownership architecture.
- Do not make Tycoon `clientId` a Co-op OAuth identifier.
- Do not introduce global customer CK/SK environment fallback.
- Do not request or store a landlord's normal internet/mobile banking password, PIN, OTP or card details.
- Do not blindly remove password-grant support if a future resource contract explicitly requires an application-user token.
- Do not guess OAuth scopes, production hosts, Balance endpoint, AccountTransactions transaction IDs, account-number length, callback registration, callback retries or signature algorithms.
- Do not change G3 tenancy matching, reconciliation, accounting posting, payment allocations or ledger behavior to compensate for an adapter mapping bug.
- Do not enable KCB, Equity or NCBA.
- Do not claim provider sandbox or production readiness from local tests.

---

**Final state of this branch:** a detailed, source-linked implementation specification is recorded in the docs. Application fixes are still outstanding and must be implemented and tested in a subsequent code-change branch or follow-on commit.

## 22. Cross-layer operation authorization and connection lifecycle corrections

These findings were verified against the implementation branch at the source revisions recorded in the audit. They extend the OAuth/resource-contract findings above and are mandatory before the frontend/backend pair can be called aligned.

### 22.1 Strategy-specific entitlement: current code is too permissive

Current source path:
- POST /bank/accounts/:id/sync calls bankService.sync(), then bankSyncService.synchronizeBankAccount().
- strategyForProvider('COOP') selects createCoopSyncStrategy(), whose mode is full_statement_window.
- CoopSyncStrategy.fetchPage() calls adapter.getFullStatement(). This is not AccountTransactions polling.
- hasBankSyncEntitlement() currently returns poll === true OR statement === true.
- Therefore poll-only account entitlement can pass the generic gate and authorize a FullStatement request. This contradicts the intended separation between poll and statement capabilities.

Required correction:
- FullStatement date-window sync requires statement === true.
- Manual date-range statement import requires statement === true.
- AccountTransactions polling, only after stable transaction identity and endpoint behavior are verified, requires poll === true.
- Replace the generic OR predicate with strategy/resource-specific authorization. Never use poll as a fallback for FullStatement or statement as a fallback for AccountTransactions.
- Ensure sync result/checkpoint metadata identifies FullStatement date-window sync, not AccountTransactions polling.
- Preserve the existing sync lease/fence and account/connection revalidation; change only the capability semantics and their tests.

### 22.2 Manual statement import does not enforce the complete provider gate

bank.service.importStatement() currently checks account connectionStatus, statement entitlement and active parent connection before calling getFullStatement(). It does not apply the provider operationalReady/non-production lab gate used by bankSync.service.js, and it does not re-read the parent connection after the provider request before calling storeAndReconcile().

Required correction: use the same effective provider-readiness/lab decision as scheduled/manual sync, then revalidate the current account association and parent BankConnection after the provider response and immediately before ingestion. A disconnect or reauthorization/association change during the provider request must prevent stale results from being accepted.

### 22.3 Parent disconnect leaves child account flags stale; webhook does not check parent

Current source facts:
- connectionService.disconnect() changes BankConnection.status to disconnected but does not change linked BankAccount.connectionStatus or entitlements.
- bankService.importStatement() and bankSync.service.js check parent connection status for ordinary request paths. Sync also rechecks at page boundaries.
- webhook.routes.js queries a connected BankAccount by account-number hash and checks its webhookIngest entitlement, but does not load BankAccount.connectionId and verify that the parent BankConnection exists, belongs to the same client/provider and is active.
- The callback route has a separate overall readiness/lab exposure gate. Within any environment where that route is exposed, stale child flags can still authorize a callback after parent disconnect because the parent is not checked.

Required correction:
1. Keep BankAccount.connectionStatus distinct from BankConnection.status.
2. Derive/expose effective account state with the current parent status; missing parent data is unavailable.
3. Every sync/import/webhook operation must verify the parent BankConnection belongs to the same Tycoon client, is COOP and is active.
4. Webhook callbacks after parent disconnect must be rejected or safely quarantined before transaction ingestion.
5. Manual statement import must re-check parent state after provider retrieval and before ingestion.
6. A disconnect must immediately make effective account operations unavailable. A child-record cascade is optional, but must not create partial or misleading state.

### 22.4 Connection create and reauthorization outcomes

connectionController.create() returns HTTP 201 when connectionService.create() returns. connectionService.create() catches an initial OAuth failure, persists BankConnection.status = failed and authMeta.lastAuthError, then returns the public DTO. This is resource creation with failed provider authentication, not a successful connection authorization. The frontend must inspect the DTO status and display a failed-auth state.

Reauthorization authenticates staged credentials and only promotes them after success, preserving the previous credential version on failure. Its current catch converts all causes to a generic BankAuthFailed. Preserve a safe typed category/code so invalid key, wrong token type, scope, rate limit and upstream outage remain distinguishable without exposing raw provider messages or secrets.

### 22.5 Effective capability derivation

Do not derive an operational account permission from a static registry boolean alone. The current registry marks statementImport, balance and webhook true, while the readiness profile says statement is not sandbox verified and balance/webhook are not contract/sandbox verified. Keep implementation presence, contract verification, account entitlement, environment-specific lab allowance and production operational readiness separate.

At minimum:
- FullStatement statement entitlement may be allowed only under the explicit verified contract and current provider readiness/lab rules.
- Balance and webhook entitlements remain unavailable in production until their resource/callback contracts and operational readiness are verified.
- The manual statement endpoint enforces the same readiness/lab policy as scheduled sync.
- A frontend DTO can report configured capability, but must not label it operational when the provider readiness gate is false.

### 22.6 Required tests

- Poll=true / statement=false cannot authorize FullStatement sync.
- Statement=true / poll=false can authorize FullStatement only under active parent connection and permitted readiness/lab state.
- Manual statement import rejects outside the readiness/lab policy and rejects if parent disconnects during the provider request.
- Callback after parent disconnect or with missing/mismatched parent connection is not ingested.
- Child account stale connectionStatus and entitlement flags cannot bypass the parent check.
- HTTP 201 with status=failed is not reported as provider authorization success.
- Failed reauthorization retains old credential version and returns a safe typed error.
- Frontend effective-parent-state gate is tested against active, failed, disconnected and missing parents.