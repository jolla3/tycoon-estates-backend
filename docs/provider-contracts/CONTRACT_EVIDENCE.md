# G4 Provider Contract Evidence

Last updated: 2026-11-20 (Co-op Connect APIs 2.0.0 evidence added)

## COOP — AccountFullStatement (supplied OpenAPI)

**API:** AccountFullStatement  
**Version:** 1.0.0  
**Operation:** `POST /`  
**Server (sandbox):** `https://openapi-sandbox.co-opbank.co.ke/Enquiry/FullStatement/Account/1.0.0`

### Verified by supplied FullStatement specification

| Topic | Evidence |
|-------|----------|
| Request fields | `MessageReference`, `AccountNumber`, `StartDate`, `EndDate` |
| Success response envelope | Requires `MessageCode`, `MessageDateTime`, `MessageDescription`, `MessageReference` |
| Transactions array | `Transactions` referencing AccountTransaction items |
| Item fields | `TransactionId`, `TransactionDate`, `ValueDate`, `Narration`, `TransactionType`, `ServicePoint`, `TransactionReference`, `CreditAmount`, `DebitAmount`, `RunningClearedBalance`, `RunningBookBalance`, `DebitLimit`, `LimitExpiryDate` |
| Direction | `TransactionType` described as **C** = Credit, **D** = Debit; amounts also present as CreditAmount/DebitAmount |
| Dates | `TransactionDate` and `ValueDate` are separate properties |
| Auth expectation | OAuth2/Bearer on the API channel (not token lifecycle detail) |

### Schema inconsistencies / limits (documented)

- `AccountNumber` min/max length **14** while an example value may contain **11** digits — treat length rules as schema-declared; do not invent alternate formats.
- Individual transaction properties are **not** marked required in the supplied schema.
- No **currency** field on the transaction item schema.
- `TransactionId` described as unique; **uniqueness scope is not defined** (account vs bank-wide vs connection).

### Still unverified (behavior / operations)

| Topic | Status |
|-------|--------|
| Live sandbox response fixtures matching schema | Not demonstrated in this workspace |
| Grant choice per resource, exact resource scopes, client_credentials token TTL/refresh behavior | The Connect 2.0.0 guide documents multiple grants; per-resource token type, exact scopes and client_credentials lifecycle still need resource-level confirmation and sandbox verification |
| Runtime guarantees for missing fields / contradictory amounts | Not verified against sandbox |
| Currency behavior for FullStatement items | Not in schema |
| **Separate** AccountTransactions **list** API operation item schema & polling semantics | **Not** verified by FullStatement component reuse — list polling remains **disabled** |
| Callback retry / HTTP acknowledgement contract | Not established |
| INS inbound Basic credential scope | See below |

### INS inbound authentication scope

Co-op SendTransactionINS materials describe a **Basic Auth Endpoint Credential** as the callback-channel credential. Available project evidence supports treating this as an **application-level integration credential** (platform `COOP_INS_BASIC_SECRET`), not as per-customer outbound OAuth secrets stored on `BankConnection`.

Outbound Co-op API credentials remain connection-scoped via the secrets manager.

If future official Co-op documentation requires per-subscription INS secrets, the webhook verifier must be extended; until then, inventing per-connection INS secrets is not justified.

## KCB / EQUITY / NCBA

No project-owned verified OpenAPI for G4 rent-monitoring account feeds. Adapters remain disabled shells (fail closed).

## Implementation mapping

- FullStatement date-window sync uses documented request shape; direction mapping uses amounts and C/D `TransactionType`.
- AccountTransactions **list polling remains disabled**.
- Webhook exposure requires operational readiness or explicit lab override.


## COOP - Co-op Connect APIs 2.0.0 (supplied guide)

**Source:** Co-op Connect APIs 2.0.0 documentation, with developer portal reference `https://developer.co-opbank.co.ke/store/apis/documentation` and support contact `openbankingcustomersupport@co-opbank.co.ke`. The guide was supplied for this review. This evidence does not claim production credentials or sandbox calls were tested.

### OAuth and DCR facts

- The guide describes DCR at `/client-registration/v0.17/register`, authenticated with Basic credentials for the registration administrator. Its example registration payload advertises `client_credentials password refresh_token` and `saasApp: true`. DCR returns a `clientId` and `clientSecret` pair.
- The returned OAuth `clientId` / `clientSecret` are the application's Consumer Key (CK) / Consumer Secret (SK). They are not Tycoon's `BankConnection.clientId`.
- The guide separately demonstrates a password grant with CK/SK Basic authentication plus username, password and scope. It also explicitly says a different grant may be used.
- The PHP HOWTO separately demonstrates the CK/SK-only `client_credentials` grant using a form-urlencoded POST to `https://developer.co-opbank.co.ke:8243/token`. This directly supports application-token acquisition without username/password.
- The Java HOWTO shows GET to the token URL without the explicit grant body, conflicting with the PHP POST example. The implementation target is the explicit POST/form example, subject to sandbox verification.
- The generic password-grant scope example `apim:subscribe apim:api_key` is not verified as the scope for the account enquiry resources.
- The error table distinguishes application and user token types (`900905` when the wrong type is sent). The accepted token type must be checked for each target resource.
- The password-grant sample's `expires_in: 3600` and `refresh_token` do not prove the client_credentials response lifetime or refresh behavior.

### Resource paths and payload facts

| Resource | Documented route | Supplied evidence | Current implementation decision |
|---|---|---|---|
| Account Validation | `POST /Enquiry/Validation/Account/1.0.0` | Request has MessageReference/AccountNumber; MessageCode `0` = valid, `-1` = invalid | Implement typed valid/invalid result; never treat `-1` as provider outage |
| Account Transactions | `POST /Enquiry/AccountTransactions/1.0.0/Account` | Request includes NoOfTransactions; response sample item has TransactionDate, ValueDate, TransactionType C/D, TransactionReference, CreditAmount, DebitAmount and running balances | Polling stays disabled until stable transaction ID semantics are confirmed |
| Mini Statement | `POST /Enquiry/MiniStatement/Account/1.0.0` | Supplied sample shows account name, product, balances and account summary fields; it does not show a Transactions array | Not treated as a transaction feed; capability remains unimplemented until purpose/response contract is clarified |
| Full Statement | Separate FullStatement OpenAPI: `POST /` at the documented versioned FullStatement server | MessageReference, AccountNumber, StartDate, EndDate; transaction items include TransactionId, TransactionDate, ValueDate, TransactionType C/D, CreditAmount, DebitAmount, TransactionReference and running balances | Use `mapCoopFullStatementItem` consistently on manual and scheduled paths |
| Account Balance | No exact path/request schema established by the supplied guide/OpenAPI snippets | Existing code uses `/AccountBalance` without matching supplied resource evidence | Keep disabled; obtain exact resource contract |

The guide's Account Validation test examples include 11-digit numbers (for example `36001873000`), while the FullStatement schema and other examples use 14-character account numbers. This is a source inconsistency, not permission to silently alter every account-number validator. Confirm accepted formats per resource.

### Provider error semantics supplied by Co-op

The guide documents, among others:

| HTTP / Message code | Meaning | Required application treatment |
|---|---|---|
| `400 / -2` | Invalid or missing parameter | Request/contract error; no blind retry |
| `408 / -4` | Request timed out / backend unavailable | Transient provider failure; preserve safe retry boundaries |
| `400 / -6` | NoOfTransactions outside configured limit; maximum example 500 | Input validation/configuration failure |
| `401 / -7` | Authorization failure | Token/authentication failure |
| `401 / -8` | Account authorization failure | Account is not authorized for this API consumer; distinct from token failure |
| `400 / -11` | Message/reference exceeds allowed length | Request validation failure |
| `503 / 700700` | API blocked | Provider capability unavailable |
| `429 / 900800` | Message throttled | Rate limit; apply bounded backoff only where safe |
| `503 / 900801` | Hard throttle limit exceeded | Stop/reduce calls; do not hot-loop |
| `401 / 900901` | Invalid credentials / older token after renewal | Token lifecycle failure; any reacquisition retry must be bounded and limited to safe enquiry operations |
| `401 / 900902` | Missing credentials | Token/header construction defect |
| `401 / 900905` | Wrong access-token type | Resource-specific grant configuration defect; do not repeat same grant |
| `403 / 900906` | No matching API resource | Wrong route/version or unavailable resource |
| `401 / 900907` | API user blocked | Provider-side access block |
| `403 / 900908` | Resource forbidden / not subscribed | Subscription/onboarding issue |
| `401 / 900909` | Subscription inactive | Provider subscription lifecycle issue |
| `403 / 900910` | Insufficient scope | Scope configuration/authorization issue |
| `400 / 102511` | Incomplete payload | Payload/contract issue |

The adapter currently converts generic non-zero MessageCode responses to one provider-unavailable error. It must preserve the distinctions above. Logs must not contain raw response bodies, account numbers, tokens, CK/SK or callback credentials.

### Host and TLS boundary

The supplied examples use the developer gateway host/port for token and enquiry calls. The FullStatement OpenAPI names a separate sandbox server. The guide does not establish production hosts. Configure the token URL and each API environment/base explicitly; do not assume a single URL works for DCR, token and every resource. The examples use insecure TLS switches (`-k`, disabled certificate verification); these are documentation shortcuts and MUST NOT be copied into application runtime.
