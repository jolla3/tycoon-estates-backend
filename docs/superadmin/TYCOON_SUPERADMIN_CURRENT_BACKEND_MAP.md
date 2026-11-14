# Tycoon Estates Superadmin — Current Backend Map

**Status:** Static map of verified backend state plus the target boundaries to preserve  
**Date:** 2026-11-14  
**Repository:** `jolla3/tycoon-estates-backend`  
**Verified `main` HEAD:** `d322374abac0cd35ce205e916de70c453af0eeda`  
**Full requirements:** [`TYCOON_SUPERADMIN_BACKEND_FIRST_BASELINE.md`](./TYCOON_SUPERADMIN_BACKEND_FIRST_BASELINE.md)  
**Detailed design:** [`TYCOON_SUPERADMIN_REVIEW_BASELINE.md`](./TYCOON_SUPERADMIN_REVIEW_BASELINE.md)

---

## 1. Product in one paragraph

The Superadmin Console is the internal control plane for the Tycoon Platform Manager. The Manager creates and manages client businesses, explicitly assigns Banking and/or M-PESA, assigns monthly subscriptions or trials, and monitors each client's integrations and platform operations. It is not a customer tenant portal and it must preserve existing G3/G4/G5 domain boundaries.

## 2. Locked business rules

- Tycoon is the platform; the Manager is the platform operator; each customer is a separate Client tenant.
- A Client may be assigned `BANKING`, `MPESA`, both, or neither. Do not impose a one-product-only client type.
- Product entitlement is explicit Manager assignment. It is not inferred from whether a bank connection or M-PESA profile exists.
- Integration configuration/readiness is a separate dimension from product entitlement.
- Subscriptions are monthly based and assigned/managed by the Platform Manager.
- Trial is a trial. An active subscription assignment is not proof of payment.
- Payment is recorded as received only when a real transaction record exists and is associated with the subscription. Do not reuse tenant rent payments as subscription payment evidence.
- No automated subscription billing, invoices, checkout, dunning, prices, grace-period logic or invented plan features in this scope.
- Tycoon owns the Daraja application and platform Consumer Key/Secret. Each client owns its own Till/shortcode, stored in its client-scoped merchant profile.
- Do not invent client-specific M-PESA secrets unless a verified provider contract requires them.
- Bank credentials are issued for each client and stored per client bank connection, encrypted and isolated. Preserve the existing G4 model.
- Never expose credentials, tokens, encrypted envelopes or raw provider authentication data.

## 3. Console structure

1. Overview
2. Clients
3. Client workspace
4. Integrations
5. Subscriptions
6. Users & access
7. Audit & system health

Two modes only: platform-wide and explicitly selected-client. The selected-client context must be visible and server-enforced. It is not user impersonation.

## 4. Architecture at a glance

```text
Platform Manager
      |
      v
Superadmin Console
      |
      v
Express /api/v1/platform
  authenticate + SUPER_ADMIN
      |
      v
Platform services
  |        |                |
  v        v                v
Client   Subscription   Audit / Health / Jobs
  |
  +-------------------+
  |                   |
  v                   v
Banking             M-PESA
Client BankConnection   Tycoon Daraja App Credentials
  |                    + Client MpesaMerchantProfile / Till
Encrypted BankCredential       |
  |                            v
Bank provider adapters      G5 ingestion
  |                            |
  +---------- G3 financial processing boundary --------+
```

The frontend framework/repository is not established. Inspect the actual frontend project before selecting a stack. No frontend stack is authorized by this summary.

## 5. Core data boundaries

| Record | Ownership / rule |
|---|---|
| `Client` | Root customer tenant boundary |
| `Subscription` | One per Client; target field `products[]` for explicit Banking/M-PESA assignment |
| `BankConnection` | One Client + one bank provider; multiple connections per client/provider supported |
| `BankCredential` | Separate encrypted secret record; referenced by its connection; never returned to UI |
| `BankAccount` | Client/estate physical account and connection association |
| `MpesaMerchantProfile` | Client-scoped merchant Till/shortcode, optional one estate association |
| Daraja application config | Tycoon platform-level environment credentials; not client-owned |
| G3 tenant Payment/Ledger | Rent accounting only; never use as Tycoon subscription payment evidence |

The target Subscription `products[]` assignment is not implemented in the current backend. It should be added to the existing one-per-client model, not as per-estate or per-product subscription rows.

## 6. Current backend vs required work

**Already present:** SUPER_ADMIN platform route group; Client provisioning with owner and Subscription; client activation/deactivation; client/user/audit/subscription listing; BankConnection/BankCredential encrypted client-scoped design; client-scoped M-PESA merchant profiles; G5 ingestion and provider evidence files.

**Missing or incomplete:** product entitlement field and Manager assignment; client product filters and integration summaries; Manager subscription updates; monthly end-date enforcement; subscription payment evidence model/flow (not required to automate billing); Superadmin merchant setup/admin contract; M-PESA multi-merchant live authorization proof; truthful provider/worker health; consistent inactive-client worker enforcement; durable audit failure handling; dedicated platform/Superadmin tests.



## 6A. Verified current platform API map

All routes are mounted under `/api/v1/platform` and are protected by session authentication plus `authorize('SUPER_ADMIN')`.

| Method | Route | Current behavior | Current limitation |
|---|---|---|---|
| GET | `/overview` | Aggregate platform counts and subscription-status counts | No complete product-entitlement or per-integration readiness breakdown |
| GET | `/health` | MongoDB/Redis state, selected global provider configuration and job status | False-green application status; incomplete SMS/Daraja/provider readiness |
| GET | `/clients` | Paginated client list; optional active filter | No product, name/owner search, plan or integration-readiness filters |
| POST | `/clients` | Creates Client, initial `CLIENT_OWNER` and Subscription atomically | No product assignment; requires a permanent owner password in the provisioning request; no invitation flow |
| GET | `/clients/:clientId` | Client, owner, subscription and portfolio counts | No Banking or M-PESA profile/connection summaries |
| PATCH | `/clients/:clientId` | Client rename | No product or subscription-management mutation |
| POST | `/clients/:clientId/activate` | Activates Client | Worker-wide activation semantics are not consistently enforced |
| POST | `/clients/:clientId/deactivate` | Deactivates Client | Does not consistently stop every background worker |
| GET | `/users` | Paginated platform user listing with role/client/active filters | No broad operator workflow for access management |
| GET | `/audit` | Paginated audit records with action/client filters | Audit metadata is not proven to be redacted for every producer |
| GET | `/subscriptions` | Paginated subscription list, optional status filter | Read-only; no Manager lifecycle mutation route |

Provisioning currently accepts `clientName`, `ownerName`, `email`, optional `phone`, required `password`, and optional `plan` (`trial`, `basic`, `pro`). The service creates an active subscription, defaulting the plan to `trial`. An `active` status does not prove payment.

## 6B. Verified current data-model map

```text
Client
  ├── User(s)                         // owner/admin/staff through client scope
  ├── Subscription                    // one per Client
  ├── Estate(s)
  │    ├── House(s)
  │    ├── Tenant(s)
  │    └── Staff/portfolio records
  ├── BankConnection(s)               // client + provider
  │    ├── BankCredential              // encrypted secret record, referenced by connection
  │    └── BankAccount(s)               // client/estate physical account and connection link
  └── MpesaMerchantProfile(s)          // client-owned Till/shortcode; optional one estate

Tycoon process configuration
  └── Daraja Consumer Key/Secret + environment
      └── shared process-level Daraja OAuth client / G5 services
```

| Model/service | Verified current shape | Superadmin implication |
|---|---|---|
| `Client` | `name`, `isActive`, timestamps | No native product-entitlement field |
| `Subscription` | Unique `clientId`, `plan`, `status`, `startDate`, optional `endDate` | One subscription per Client; no payment evidence or product list |
| `subscriptionService` | `trial/basic/pro`; client-scoped plan state; upgrade helper | `isActive()` checks status and ignores `endDate`; platform subscription list is read-only |
| `BankConnection` | Client/provider connection, status and credential reference/version; multiple connections per client/provider supported | Show safe connection state; do not return credential references or secret envelopes to the UI |
| `BankCredential` | Separate encrypted AES-256-GCM envelope with owner/provider/version binding | Preserve existing encryption model; no global client bank secrets |
| `BankAccount` | Client/estate/provider account association and connection relationship | Connection auth must not be confused with account validation or sync capability |
| `MpesaMerchantProfile` | `clientId`, Buy Goods Till shortcode, optional `estateId`, callback/Pull capability and operational state | Till is client merchant identity; Daraja app credentials remain platform-owned |
| `AuditLog` | Supports action/resource/metadata; metadata is Mixed | Sensitive metadata must be controlled and redacted at every write path |

## 6C. Integration and operational map

### Banking / G4

- Bank credentials belong to each client's bank connection and are stored separately in the encrypted `BankCredential` model.
- Existing connection create/reauthorize/disconnect routes are restricted to client owner/admin roles. Superadmin's current platform API has no bank-connection administration contract.
- Co-op is implemented but not operationally verified. KCB, Equity and NCBA identifiers exist but must not be represented as ready adapters.
- Preserve the G4 connection, credential and ingestion foundations. Do not create another banking credential store.

### M-PESA / G5

- Tycoon process configuration contains the Daraja application Consumer Key/Secret and environment; client `MpesaMerchantProfile` stores the client's own Till/shortcode.
- No Superadmin merchant-profile provisioning, application-to-merchant authorization or credential rotation API is present.
- Callback exposure is gated and currently not exposed in the documented deployed evidence. Pull execution is deliberately gated until provider and merchant capabilities are verified.
- The latest provider contract document records sandbox OAuth and C2B v2 registration evidence, but it does not establish that sandbox shortcodes `174379` and `600987` are the same merchant identity. Callback authentication/acknowledgement, Pull eligibility, nominated number, Buy Goods Pull fixture, pagination terminal behavior and full 48-hour entitlement remain unresolved. G3 posting remains gated.
- A successful platform OAuth token is not proof that each client Till is authorized for the required Daraja operations.

### Health, jobs, SMS and audit

- `platformService.systemHealth()` reports application health as healthy unconditionally and does not verify every required downstream provider setting or live capability.
- SMS's global Celcom configuration is platform-level. The health check omits provider settings such as base URL and sender ID and does not perform a live provider check. A provider acceptance response is not necessarily proof of handset delivery.
- Standard SMS queue processing has no lease-expiry reclaimer for rows left in `processing`; this differs from the protected G5 SMS dispatch path.
- Scheduler wrappers can classify a resolved job call as successful even when the job caught per-client failures, returned partial results or intentionally skipped work. The future console needs explicit typed outcomes.
- Client deactivation is enforced by normal request context, but the reviewed bank sync, rent status, SMS reminder and M-PESA Pull worker paths do not consistently apply the same inactive-client guard.
- `audit()` catches persistence failures and logs them instead of failing the mutation. Sensitive Manager changes can therefore complete without a durable audit entry.

## 6D. Authorization boundary

- `/api/v1/platform/*` is platform-wide and requires authenticated `SUPER_ADMIN`.
- Normal business routes use `clientContext`; a Superadmin must provide an explicit client ID and the middleware verifies the Client is active.
- An inactive Client is therefore difficult to inspect through ordinary selected-client business routes. A future diagnostics path must be explicitly designed as read-only rather than weakening `clientContext` globally.
- A selected client is a target scope, not an impersonated customer user. Preserve the real Manager as the audit actor.

## 6E. Verification limits

- This map is a static inspection of source and repository documentation at the baseline SHA below.
- No runtime API requests, provider requests, deployment, database migration or test execution were performed for this documentation set.
- The repository contains a broad test suite, but no dedicated Superadmin/platform test file was identified in the static inventory. This is not a claim that all possible tests are absent.

## 7. Critical operational guardrails

- An OAuth token for Tycoon's Daraja app does not prove access to each client's Till. Verify merchant-specific authorization before `READY`.
- The client's Till belongs to that client; the app credentials belong to Tycoon.
- Co-op adapter presence is not live readiness; KCB/Equity/NCBA are not operational adapters.
- Current `systemHealth()` has false-green behaviour and incomplete provider checks.
- Job functions may resolve after partial failures or deliberate skips. Show `SUCCESS`, `PARTIAL_FAILURE`, `FAILED`, `SKIPPED`, `BLOCKED`, `RUNNING` distinctly.
- Inactive clients are blocked by normal request context, but workers do not consistently apply the same rule.
- Audit writes currently swallow persistence failures. Sensitive actions need durable, visible audit outcomes.
- A selected client ID from the browser is not authorization. Enforce scope on every server request.
- Keep the G3/G4/G5 source contracts. Do not invent a new ledger or payment engine.

## 8. Implementation order

1. Re-fetch `main` and record the current SHA.
2. Inspect the actual frontend repository; do not guess its stack.
3. Add explicit product entitlements to the existing one-per-client Subscription and define monthly date semantics.
4. Add Manager subscription assignment/update and client list/detail summaries.
5. Add truthful derived Banking/M-PESA readiness summaries.
6. Fix health, typed job outcomes, inactive-client worker enforcement and audit reliability.
7. Implement the seven-area console using the existing frontend conventions.
8. Run and report actual isolation, secret-redaction, G3/G4/G5 and platform tests.

## 9. Source baseline

GitHub `main`: `d322374abac0cd35ce205e916de70c453af0eeda`.

Key current source files:

- `src/routes/platform.routes.js` — `8385157f569b53b13ff07b7e7c8ff00948b30b7e`
- `src/services/platform.service.js` — `a809ba6bb3a25822918e70f4a907dd6de3886d49`
- `src/models/Client.js` — `03c8493ab817b998cf529cf790d8d55ce3473c4c`
- `src/models/Subscription.js` — `3a11435fbf1d08e9e3bf47b26056b78c9b2f0c65`
- `src/models/BankConnection.js` — `69abcbf98fda85641bd4c79de39f1b664d2413b3`
- `src/models/BankCredential.js` — `f26e5f82f576fc2a2b8bbb6a46df840a5e377d2f`
- `src/models/MpesaMerchantProfile.js` — `4b12fcd147a6c01dced130ae1a4fe6eab544b706`
- `docs/provider-contracts/G5_DARAJA_C2B_PULL_EVIDENCE.md` — `4844bae384aed99c86e00fda483adc6d1de2adbe`

**Verification boundary:** Documentation was prepared from a static source review. No tests were run and no runtime/provider readiness was re-verified during this documentation task.