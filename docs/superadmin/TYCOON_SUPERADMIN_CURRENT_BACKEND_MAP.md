# Tycoon Estates Superadmin — Current Backend Map

## Authoritative M-PESA architecture correction — 2026-11-19

The review-branch implementation below is only the first DRAFT Till slice. The target product is one merchant profile serving multiple same-client estates, including a shared PayBill used by several estates. The one-estate restriction is an implementation defect to correct, not a permanent product limitation.

### Correct target model

- `MpesaMerchantProfile` represents one actual Safaricom shortcode owned by exactly one Tycoon Client within the configured Daraja environment. Supported merchant types are `PAYBILL` and `BUY_GOODS_TILL`.
- Replace the single profile `estateId` as the authoritative relation with `MpesaMerchantProfileEstate` (or an equivalent explicit mapping collection). One profile can map to many estates in the same client; an estate can map to multiple merchant profiles where several collection channels are genuinely used.
- Add a PayBill collection-reference record mapping a normalized `BillRefNumber` to exactly one merchant profile + client + estate + tenant. Enforce unique reference per merchant profile. Retire, do not reassign, references; preserve old mappings for late payments after tenant moves.
- Callback lookup currently searches by provider + shortcode across clients, but the current unique index is only `(clientId,businessShortCode)`. Those scopes disagree. Use one global shortcode owner per provider/environment and align the migration-controlled unique index with callback lookup. Detect duplicates before migration; do not auto-merge profiles or clients.
- Canonical `MpesaTransaction` stays merchant-scoped on ingestion. `attributedEstateId` remains unset until exact reference/evidence resolution; never assign every shared-merchant receipt to every mapped estate.

### PayBill/Till processing rules

- PayBill `BillRefNumber` is optional in the Safaricom C2B contract. A missing, unknown, retired or ambiguous Tycoon reference must leave the canonical receipt unallocated; do not guess an estate or create a G3 Payment.
- Add PayBill transaction-type support end-to-end. The normalizer currently recognizes `CustomerPayBillOnline` but marks it unsupported; G5's evidence gate currently accepts Buy Goods only. Expand only after the reference-routing and receipt-identity rules are tested.
- Buy Goods Till continues through tenant-specific SMS evidence/link resolution. G5 verifies that the merchant profile has an active mapping to the selected link estate. A shared Till does not remove the tenant evidence requirement.
- BillRefNumber/reference resolution is routing evidence, not permission to bypass existing provider verification, SMS evidence policy, amount/time checks, claim fencing, G3 settlement, audit, or posting feature gates.
- Estate-scoped receipt history must not use “profile is mapped to this estate” as the receipt predicate. That would show all receipts on a shared PayBill to all mapped estates. Estate-restricted results must be tied to exact reference routing or verified `attributedEstateId`; unallocated receipts belong in an explicitly authorized client-wide review scope.

### Callback and Pull profile configuration

- C2B confirmation, optional validation and Pull-results endpoints are Tycoon-hosted shared platform endpoints. Register the same configured endpoint set against each shortcode; do not ask clients to host callbacks or supply per-client callback URLs.
- The profile must record the platform callback configuration ID/version and safe URL snapshots used at registration, alongside separate C2B/Pull registration state, response type, attempt/success timestamps and safe provider response identifiers. Keep registration evidence separate from callback capability and operational state.
- Pull registration needs the shortcode's nominated Safaricom MSISDN. Store it encrypted/protected or by a secret reference and expose only a masked value. It is merchant-specific KYC data; it is not a platform callback URL and not Tycoon's Daraja Consumer Key/Secret.
- C2B external validation is optional and requires Safaricom activation. The current `handleC2bValidation` accepts every request and is not production-safe. Implement real merchant/reference validation before enabling it.
- The current provider evidence does not establish callback cryptographic authentication. Keep public callback exposure/automatic processing blocked until authenticity, replay/abuse controls and acknowledgement behavior are evidenced. A shortcode in a request body is not authentication.
- Registration accepted != callback verified != Pull verified != operational. Handle uncertain timeouts as uncertain and reconcile before another registration attempt.

### Banking provider direction

Keep Banking on the existing provider-adapter architecture. Co-op is the first implemented provider path. KCB, Equity and NCBA have registry/adapter shells in the current source but are not marked implemented or operational. Complete each provider through the existing interface, provider-specific credential model, capability declarations and verified readiness; do not replace the connection model or describe shells as finished support.

### Required implementation sequence

1. Inventory existing profiles, shortcode collisions across clients, legacy estateId associations, canonical receipts, links and attribution.
2. Design a staged mapping/reference migration. Backfill legacy estateId to exactly one mapping before removing or ignoring the old field.
3. Establish global provider-shortcode ownership and the unique index only after conflict inventory; keep autoIndex disabled and readiness fail-closed.
4. Implement PayBill normalization + collection-reference resolution, preserving unallocated canonical receipts.
5. Update Till/G5 link and posting logic to validate active profile-estate mappings.
6. Restrict history queries by receipt-level allocation, not profile-estate membership.
7. Update Superadmin forms for merchant type and multi-estate mapping; add safe registration evidence and protected Pull-number capture. Keep registration as a separate explicit action.
8. Add migration, multi-estate, cross-client, reference resolution, callback trust, receipt query-scope and G5 regression tests before any production enablement.


## Review-branch implementation status — 2026-11-19 (not merged)

Backend review branch: `docs/superadmin-onboarding-and-history`. This is not on main or deployed.

- House list with `status=vacant` now excludes `isActive:false`, any non-null House.tenantId and any House with an ACTIVE Tenancy under the same client. `tenancyService.open` rechecks active state, vacancy and existing active tenancy inside its Mongo transaction.
- Existing bank connection and account mutation routes now allow SUPER_ADMIN after authenticate + `clientContext` + `requireProduct('BANKING')` + role authorization. Superadmin must provide explicit clientId in query; clientId is never trusted from body.
- `POST /platform/clients/:clientId/mpesa-profiles` creates a DRAFT BUY_GOODS_TILL profile for one client-owned estate. It checks active Client and same-client Estate inside the transaction, requires `merchantRegistration` readiness (`uniq_client_business_shortcode`), sets capabilities UNKNOWN and registration states NONE, and records required audit in the transaction. No Daraja secrets are stored.
- `GET /mpesa-transactions` requires auth, `clientContext` and MPESA entitlement, checks canonical query indexes, and returns a paginated allowlisted M-PESA receipt DTO. Client and estate filters are enforced through clientId, mapped merchant profiles and attributedEstateId.
- New unit schema/DTO tests were added for Till profile input and receipt query/DTO. They have not been executed.

**Current code boundary (not target product):** one DRAFT BUY_GOODS_TILL profile maps to one estate. Multi-estate mappings, PAYBILL, BillRef routing, shared callback registration evidence and protected Pull-number lifecycle are not implemented. The manual-options latest-50 mismatch remains open. No browser, DB replica-set integration or live provider tests are claimed.

## Implementation status on this review branch (supersedes "Till-only / one estateId" statements above)

Implemented in source (unit-tested; replica-set integration tests are authored but **NOT EXECUTED: required service unavailable in this execution environment**): `MpesaMerchantProfileEstate` mapping and `MpesaCollectionReference` models; PAYBILL + BUY_GOODS_TILL profile creation with `estateIds[]`; global `{provider, businessShortCode}` ownership index and readiness gates (`profileEstateMapping`, `collectionReferences`); `scripts/migrations/20261119_g54_mpesa_shared_merchant.js` (dry-run default, collision preflight, idempotent legacy backfill, explicit index creation; never run against any database by this work); PayBill normalization, exact-reference allocation and the typed `evaluateReferenceEvidence`/`postAllocatedReceipt` path that shares `executeFencedPosting` with the Till SMS path; Till evidence now requires an ACTIVE mapping and a merchant-bound link; shared callback config (`DARAJA_CALLBACK_BASE_URL`), registration evidence, encrypted+masked Pull number, explicit audited C2B/Pull registration and reconcile; fail-closed `handleC2bValidation`; allocation-scoped `/mpesa-transactions`; paginated manual-options; reference retirement on tenancy close.

Still blocked/unverified: callback authentication, receipt-identity gate `canonicalReceiptIdentity` (hard-coded false, so automatic posting stays disabled), Pull eligibility/fixtures, and whether closed-tenancy late payments should auto-post under G3 (they go to review).

Rollback/recovery for the migration: delete only `mpesamerchantprofileestates` rows with `source: 'LEGACY_MIGRATION'` and drop the four new indexes; `profile.estateId` and `uniq_client_business_shortcode` are untouched unless `--drop-legacy-index` is passed explicitly.

## Adversarial source review result — 2026-11-19 (verified against branch HEAD `e491899`)

The sections above were checked against source. They are accurate; the findings below add facts, they do not change the target.

- **Deployment model (verified):** `env.DARAJA_ENVIRONMENT` is a single process-wide value (`sandbox` default) and the OAuth client is built from it; there is no per-profile environment field and one deployment uses one MongoDB. Sandbox and live therefore do not share a database in the supported topology, so the global ownership index is `{provider, businessShortCode}` without an environment key. The profile still records the environment of each registration attempt so a shared-DB deployment would be detected rather than silently mixed.
- **Scope mismatch (verified):** `resolveMerchantProfilesByShortCode` filters by `provider + businessShortCode` across all clients while the only unique index is `{clientId, businessShortCode}`; two clients can both own a shortcode and every receipt for it quarantines as `ambiguous_merchant`.
- **Evidence gate (verified):** `evaluateEvidence` requires `profile.estateId === link.estateId` and `txn.transactionType === CustomerBuyGoodsOnline`; `normalizeC2bConfirmation` and `normalizePullTransactionRow` reject `CustomerPayBillOnline` as `unsupported_transaction_type`.
- **Link merchant selection (verified):** `resolveOperationalMerchant` uses `.limit(2)` and returns null when two merchants are active for an estate, so a second channel silently disables links.
- **History leak (verified):** `mpesaTransactionService.list` adds `merchantProfileId $in <profiles mapped to the estate>` to the estate scope; every receipt of a shared merchant would show to every mapped estate.
- **Validation (verified):** `handleC2bValidation` accepts every request. External validation is not enabled for any merchant and must stay off.
- **Receipt identity gate (verified):** `inspectMpesaIndexes` hard-codes `canonicalReceiptIdentity=false`; automatic posting is blocked by design and remains so.
- **Correction to the status section above:** the new tests listed there are unit tests that can run without a database; only replica-set integration tests need MongoDB. None of the integration tests were executed in this review environment (no MongoDB/Redis available).

## Design review hardening — 2026-11-19

Before implementation, the plan was challenged for hidden assumptions and unsafe shortcuts:

1. **The one-estate shape is an implementation constraint, not product policy.** Target is one merchant profile mapped to many same-client estates via a separate relation; current profile.estateId and G5 equality checks need a staged migration and posting-rule change.
2. **Registration uses shared platform callbacks.** C2B confirmation/optional validation and Pull-results endpoints are Tycoon-hosted and registered against each shortcode. Persist their config version/URL snapshot on the profile. Pull's nominated MSISDN is merchant-specific and must be stored protected/encrypted. Profile create must not silently register or mark operational.
3. **Shortcode identity needs a global ownership gate.** Current callback lookup searches across clients while the unique key is per-client. Inventory collisions, then enforce one client owner per provider/environment shortcode with a migration-controlled index. Do not auto-merge duplicates.
4. **Transaction history must not combine record types.** M-PESA history reads canonical MpesaTransaction receipts, not SMS submissions and not ledger Payment rows. The DTO must be safe and scope by client plus the selected estate's merchant profiles/attribution.
5. **Banking access stays entitlement-gated.** Superadmin must use one explicit active clientId through clientContext. The existing BANKING entitlement check remains active. Do not add a global/bypass route or store new credentials. Existing Co-op credentials remain encrypted in BankCredential.
6. **Tenant availability must be authoritative.** Filter active houses and exclude active tenancies, but also recheck inside the same Mongo transaction that opens the tenancy. A dropdown is not a concurrency or authorization boundary.
7. **No broad UI redesign.** Fix the platform content shrink/wrap and breakpoint issues at the shell/evidence components. Do not replace the whole Superadmin UI or introduce a new design system.

## Current post-merge implementation amendment — 2026-11-19 (authoritative)

Verified backend main: 25d9969eb4f1c734f360337f0a3d64b83d465a6a. The older baseline/status tables below are historical architecture evidence; this amendment supersedes contradictory current-status statements.

### Banking credential setup

- Existing customer routes are mounted at /bank/connections and /bank/accounts.
- clientContext supports SUPER_ADMIN only when an explicit clientId is supplied in query or path, and validates that the target Client is active.
- requireProduct(BANKING) still applies to these customer routes.
- Connection create/reauthorize/disconnect and account create/sync/statement mutations currently authorize only CLIENT_OWNER and CLIENT_ADMIN. This is the backend permission blocker for Superadmin onboarding.
- The next change should narrowly add SUPER_ADMIN to those route allowlists after clientContext, retain requireProduct, pass the selected client explicitly, and reuse connectionService/bankService and encrypted BankCredential. No second credential store is required.

### M-PESA merchant profiles

- MpesaMerchantProfile exists and stores clientId, Buy Goods Till shortcode, optional estateId, lifecycle/capability/registration evidence and actor IDs.
- platformIntegrations.service.js only reads and redacts profile data for the console. There is no HTTP route/controller/service for Superadmin profile creation or management.
- darajaC2b.service.js and darajaPull.service.js implement registration calls, but they are not exposed as Superadmin profile-management HTTP routes.
- Tycoon owns the Daraja application Consumer Key/Secret/environment at process level. A client profile stores that client's Till/shortcode, not a duplicate of the platform application's secrets.
- New profile creation must validate Client and optional Estate ownership; begin at DRAFT with unknown capabilities and no registration evidence. A caller must not set ACTIVE or VERIFIED by request input.

### Canonical M-PESA transaction history

- MpesaTransaction stores canonical provider receipts with provider verification, claim/posting state and attribution fields.
- There is no client-facing paginated list/read route or safe transaction DTO.
- The next API should use authenticated clientContext, requireProduct(MPESA), pagination, client scope and estateFilterClause; expose allowlisted receipt fields only. Preserve distinctions among canonical receipts, SMS submissions and G3 Payments.
- The frontend should render M-PESA receipts as a source within the existing Transactions page, rather than a separate page.

### Post-P0 fixes and verification

- P0 frontend-contract fixes are merged in backend main: HouseType create estateId contract, safe BankTransaction DTO, and explicit manual-payment tenancy resolution.
- The manual-options query still has a latest-50 limit while the payment resolver searches all eligible tenancies.
- Nineteen DB-backed integration tests were added but not executed; no live deployment/provider check is claimed.

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

## 8. Backend-only implementation order

1. Re-fetch remote `main`, record the exact commit, and verify the application-source baseline. Documentation-only commits do not change the source baseline.
2. Add explicit `Subscription.products[]` with an empty-array default and Manager-only update contracts. Keep enforcement disabled.
3. Build a read-only client entitlement inventory and explicit Manager assignment workflow. Do not infer assignments from bank connections or M-PESA profiles.
4. Consolidate all subscription plan/product/date writes under Platform Manager authority. Retire the client upgrade write path and non-Manager plan writers.
5. Add fail-closed Banking/M-PESA HTTP gates and the specific worker gates. Preserve provider ingress and durable G5 financial-event capture.
6. Add required audit semantics for sensitive Manager mutations while preserving shared best-effort auditing elsewhere.
7. Correct only the identified operational-health and job-outcome gaps that are in this backend contract.
8. Run targeted migration, authorization, worker, provider-ingress and G3/G4/G5 regression tests. Report commands, counts and results; do not claim tests that were not run.

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

## Appendix A. Backend entitlement and mutation contract — 14 November 2026

### A1. One entitlement source

- `Subscription.products` is authoritative for the subscription's `clientId`.
- Allowed products are `BANKING` and `MPESA`; one client may have either, both or neither.
- Missing subscription, missing `products` or an empty array grants neither product once enforcement is enabled.
- Schema default is `[]`. Signup, demo seeding and provisioning must not silently grant a product.
- Integration records, provider credentials, merchant profiles and historical usage are not evidence of entitlement.

### A2. Subscription writer authority

Only the Platform Manager may change plan, products, start date or end date. The implementation inventory must cover:

- `POST /api/v1/subscription/upgrade` and its controller.
- `subscriptionService.upgrade()`.
- `subscriptionService.setPlan()`.
- `subscriptionService.ensureForClient()`.
- Platform client provisioning.
- `authService.signup`.
- `seedDemoClient` and scripts/direct model writes found by repository-wide search.

Provisioning/signup helpers may create a trial subscription, but must create it with `products: []` and must not become an alternate authority for later plan/product/date changes. The client `POST /subscription/upgrade` path must stop mutating state and return a stable forbidden response. Frontend inspection is not a prerequisite for this backend task.

### A3. HTTP entitlement gates

Introduce shared `requireProduct('BANKING' | 'MPESA')` middleware after authentication and validated `clientContext`. It checks the subscription for resolved `req.clientId`. Missing subscription/product returns `403 PRODUCT_NOT_ENTITLED`.

- Banking account and bank-connection customer routes require `BANKING`.
- Customer M-PESA collection/configuration routes require `MPESA`.
- Platform `/api/v1/platform/*` remains under its existing SUPER_ADMIN contract and is not product-gated.
- A SUPER_ADMIN using a customer-facing route does not bypass the product gate; platform administration uses platform routes.

### A4. Worker gates and explicit exclusions

| Worker/path | Required client state |
|---|---|
| `bankSyncJob` | Client active and `BANKING` entitled |
| `mpesaPullJob` | Client active and `MPESA` entitled |
| M-PESA collection matching and protected collection-SMS work in `g5CollectionJob` | Client active and `MPESA` entitled |
| `rentStatusJob` | No Banking/M-PESA entitlement gate |
| `smsReminderJob` and standard SMS queue drain | No Banking/M-PESA entitlement gate |

Keep M-PESA-specific matching/protected-SMS work separate from standard rent/SMS work. A product gate must not suppress unrelated tenant rent operations or ordinary reminders.

### A5. Provider ingress and financial-event retention

Keep public M-PESA and Daraja webhook ingress outside session-based product middleware. Loss of `MPESA` entitlement must not cause an authenticated provider event to be discarded. Persist G5 ingestion under its existing contract; downstream product operations remain blocked/non-operational or use the existing G5 quarantine/blocked state. Do not invent a second inbox, redesign G5 or drop financial events.

### A6. Migration, rollout and audit

- First produce a read-only inventory of Clients, subscriptions and separately observed integration facts.
- Never backfill `BANKING` or `MPESA` from a bank connection, merchant profile, transaction or usage history.
- Assign products only through explicit Manager decisions, recording actor, target client, before/after values and reason.
- Keep enforcement disabled until assignments are reviewed and complete.
- Add `auditRequired`/equivalent semantics for high-risk Manager mutations. Prefer the same Mongo transaction where supported; otherwise use a durable failure-safe strategy or fail the mutation.
- Preserve shared best-effort `audit()` behavior for unrelated modules. Do not globally change its failure semantics.
- Do not record payment as received without an actual transaction linked to the subscription. No billing, invoicing or second ledger is introduced.

---

## Appendix B. Implemented backend contracts — branch `feat/superadmin-subscription-entitlements`

Status: **implemented in source, behavioural verification pending.** No tests, linting, builds or installs were run for this work (explicitly out of scope for the assignment). Entries below describe what the code does, not what has been proven at runtime.

### B1. Subscription authority (A2 realised)
- `Subscription` gained `products` (`BANKING` | `MPESA`, default `[]`), `assignedByUserId`, `lastChangedByUserId`. Existing plan/status/date fields are unchanged.
- `subscriptionService`: `ensureDefaultForClient` (trial/active/`products: []`; signup + seed only), `createForManager` (insert-only; duplicate → `409`), `updateByManager` (sole ongoing mutation: partial plan/products/dates, `endDate: null` clears, status is not mutable). `setPlan`, `ensureForClient` and client `upgrade` were removed. `authService.signup` now goes through `ensureDefaultForClient`.
- `POST /api/v1/subscription/upgrade` → stable `403 FORBIDDEN`, no mutation.
- `POST /api/v1/platform/clients` accepts optional `products`, `startDate`, `endDate` (strict schema). `PATCH /api/v1/platform/clients/:clientId/subscription` is the Manager update. `GET /api/v1/platform/entitlement-inventory` (paginated, `product`/`isActive` filters, includes clients with no subscription; products only from `Subscription.products`).
- Required audit: `auditRequired()` writes inside the caller's Mongo session. Provisioning (`CLIENT_CREATED`) and subscription updates (`SUBSCRIPTION_UPDATED_BY_MANAGER`, metadata `before`/`after`) commit or roll back with the mutation. `audit()` stays best-effort for all other modules.

### B2. Entitlement enforcement (A3/A4 realised)
- Single rule in `src/services/entitlement.service.js`: Client exists AND `isActive === true` AND `Subscription.products` contains the product; fails closed (reasons: `PRODUCT_UNKNOWN`, `CLIENT_NOT_FOUND`, `CLIENT_INACTIVE`, `SUBSCRIPTION_MISSING`, `PRODUCT_NOT_ASSIGNED`). Never inferred from plan/status/dates/payments/connections/profiles.
- HTTP: `requireProduct(product)` after `clientContext`, before role `authorize`; denial is `403 PRODUCT_NOT_ENTITLED`. BANKING: `/bank/*`, `/bank/connections/*`, `/transactions/*`. MPESA: `/mpesa-collection/*` (SUPER_ADMIN does not bypass on customer routes). Not gated: deposits, billing, rent/SMS jobs, public/provider ingress.
- Workers: `bankSyncJob` checks per client before sync (cached per run); `mpesaPullJob` checks per profile **before** lease acquisition; `matchSubmission` leaves entitlement-blocked evidence untouched (state unchanged); `dispatchProtectedBatch` releases a claimed row back to `queued` (lease token fenced, `sendStartedAt` untouched) with a 5-minute `nextRetryAt` so it resumes after entitlement is restored and is not re-claimed in the same pass. No G5 event/row is deleted or consumed.
- **Rollout consequence:** existing clients have no `products`, so Banking/M-PESA client routes and workers are blocked until a Manager assigns products via the PATCH endpoint. Assign before deploying.

### B3. Platform read APIs (all `authenticate → authorize('SUPER_ADMIN')`)
| Route | Notes |
|---|---|
| `GET /platform/clients` | filters: `search` (client/owner name/email), `product` (BANKING/MPESA/BOTH/NONE), `plan`, `subscriptionStatus`, `hasSubscription`, `bankProvider`, `bankConnectionStatus`, `bankAccountConnectionStatus`, `bankValidationStatus`, `mpesaState`, `callbackCapability`, `pullCapability`, `c2bRegistrationState`, `pullRegistrationState`, `isActive`; batched enrichment; `subscription.present` distinguishes missing from empty products |
| `GET /platform/clients/:clientId` | owner (safe fields), subscription incl. actor refs, counts, Banking summary, M-PESA summary with safe profiles and ingestion evidence timestamps |
| `GET /platform/clients/:clientId/diagnostics` | read-only; works for inactive clients; adds entitlement evaluation per product, last 25 audit records, job outcomes (per-client counts where the job reports them) |
| `GET /platform/overview` | all prior metrics + `productAssignments`, `bankingIntegration`, `mpesaIntegration` distributions |
| `GET /platform/integrations/banking` | one row per `BankConnection` with account rollups; filters `clientId`, `clientIsActive`, `provider`, `status`, `validationStatus`, `accountConnectionStatus` |
| `GET /platform/integrations/mpesa` | one row per merchant profile with `blockers` (derived from stored states only); callback and Pull kept independent |
| `GET /platform/audit` | filters `clientId`, `userId`, `action` (comma list), `resource`, `resourceId`, `from`, `to`; redacted metadata |
| `GET /platform/health` | see B4 |

Never returned: `credentialsRef`, encrypted account numbers/hashes, tokens, raw provider payloads, secrets.

### B4. Health and job outcomes
- Health is evidence-based and makes **no live provider calls**. Config presence ≠ operational. Co-op: adapter implemented, config presence, `providerVerified: null`, `operationalCapability: 'unverified'`; KCB/EQUITY/NCBA `not_implemented`. Daraja: platform app credential presence only; **no OAuth outcome is persisted**, so none is claimed; per-Till state comes from merchant profiles; ingestion evidence from `MpesaIngestionEvent` timestamps. Celcom: requires base URL, partner ID, API key and sender ID (previously only two were checked); `sent` = provider-accepted, handset delivery is not tracked.
- Scheduler status reports `initializedInThisProcess`, registered jobs, running jobs and `lastOutcome` per job. Outcomes (`SUCCESS`, `PARTIAL_FAILURE`, `FAILED`, `SKIPPED`, `BLOCKED`, `RUNNING`) are classified from the summary each job returns, with start/finish/duration and counts. Jobs that return no counts (`smsReminder`) report `counts: null`. Intervals, lock behaviour and process roles are unchanged.

### B5. Known limitations
- Subscription `endDate`/`status` still do not affect entitlement (no automatic expiry; separate decision).
- Job outcome telemetry is Redis/in-memory operational data, not financial truth; per-client job counts exist only for `bankSync`.
- Audit queries on `userId`/`createdAt` rely on new non-unique indexes declared on the model; they are not created by this change at startup.
- Provider-verified Co-op/Daraja readiness cannot be shown without a live-check mechanism that is out of scope.
