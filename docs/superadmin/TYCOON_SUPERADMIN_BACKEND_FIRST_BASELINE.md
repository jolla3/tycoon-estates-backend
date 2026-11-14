# Tycoon Estates — Superadmin Backend-First Baseline

**Document:** Superadmin Product Requirements / Backend-First Baseline  
**Status:** Baseline drafted from Manager sign-off and backend inspection  
**Date:** 2026-11-14  
**Repository:** `jolla3/tycoon-estates-backend`  
**Source baseline:** GitHub `main` at `d322374abac0cd35ce205e916de70c453af0eeda`  
**Companion documents:** [`TYCOON_SUPERADMIN_CURRENT_BACKEND_MAP.md`](./TYCOON_SUPERADMIN_CURRENT_BACKEND_MAP.md) · [`TYCOON_SUPERADMIN_REVIEW_BASELINE.md`](./TYCOON_SUPERADMIN_REVIEW_BASELINE.md)

**Audience:** Product owner, Platform Manager, backend engineer, frontend engineer, reviewer

---

## 1. Product definition

The Tycoon Estates Superadmin Console is the internal control surface used by the Tycoon Platform Manager to provision and manage customer businesses using Tycoon Estates, assign their product access, manage their monthly subscription assignment, and understand the operational state of their Banking and M-PESA integrations.

Tycoon is the platform. The customer is a Tycoon client. A client may have Banking, M-PESA, or both assigned. The client remains one customer and one tenant boundary regardless of which products it uses.

The console is an operator tool, not a customer-facing tenant portal. It must not become a second rent-management application or a second financial ledger. Existing G3/G4/G5 domain boundaries remain authoritative.

## 2. Target user and operating model

### Primary user

The primary user is the Tycoon Platform Manager (`SUPER_ADMIN`). The Manager creates customer clients, assigns products and subscriptions, reviews setup, and monitors the platform.

Client owners and client administrators are customer-side users. They operate within their own client boundary and must not receive Platform Manager privileges.

### Two operating modes

1. **Platform-wide mode:** manage and inspect all Tycoon clients, subscriptions, product assignments, users, integration states, audit events and platform health.
2. **Selected-client mode:** open one explicitly selected client workspace to inspect that client's owner, portfolio, assigned products, subscription and integration configuration/readiness.

The selected client must be visible in the interface. It is a scope selection, not silent impersonation. The audit trail must retain the actual Platform Manager as the actor.

## 3. Core product concepts and rules

These concepts must remain separate throughout the product and implementation.

| Concept | Meaning | Must not be confused with |
|---|---|---|
| Client | The customer/business boundary inside Tycoon | A bank account, Till, estate or product |
| Product entitlement | Which Tycoon product(s) the Manager assigned to the client | Whether an integration is configured or healthy |
| Integration configuration | The actual bank connection/account or M-PESA merchant profile configured for the client | Product entitlement or subscription payment |
| Subscription | The Manager-assigned right to use Tycoon for a monthly term, or an explicitly assigned trial | Proof that money was received |
| Payment evidence | A real transaction record that can be tied to a subscription payment | A subscription status, an admin action, or a tenant's rent payment |

### 3.1 Product assignment

The available product entitlements are:

- `BANKING`
- `MPESA`

A client may be assigned Banking only, M-PESA only, or both. A client may also have neither during an unassigned/onboarding state. Do not introduce a mutually exclusive `clientType: BANK | MPESA` field.

The Manager's explicit product assignment is the source of entitlement. Do not infer entitlement from the existence of a `BankConnection`, `BankAccount`, or `MpesaMerchantProfile`.

Product assignment and integration readiness are separate. For example, a client can be entitled to M-PESA while its Till profile is still incomplete or Safaricom capability remains unverified.

### 3.2 Subscription model

- Subscriptions are monthly based.
- The Platform Manager creates the client and assigns the subscription.
- A trial is a trial. It must be presented and treated as a trial, not as a paid subscription.
- The system only knows that a subscription payment was received when a real payment transaction record exists and is associated with that subscription. An administrator assigning or activating a subscription is not payment evidence.
- Do not mark a subscription as paid merely because its service status is `active`.
- There is no automatic charging, payment-provider checkout, invoice generation, or payment reconciliation in this product scope.
- Do not invent prices, trial duration, plan feature matrices, grace periods, or automatic renewal behaviour.
- Current code has plan identifiers `trial`, `basic`, and `pro`. Their prices and feature differences are not established by this PRD. Product entitlements remain a separate assignment from the plan label.

The console should let the Manager see and manage the assigned plan and monthly dates. The exact access behaviour after a term end date must be implemented only against an explicit product rule; current source does not reliably enforce `endDate`.

**Important financial boundary:** subscription payment evidence is not the same thing as tenant rent money recorded by G3. Do not reuse tenant rent `Payment` or ledger records as a proxy for Tycoon subscription revenue.

### 3.3 Banking ownership

- Each client has its own bank relationship and client-specific bank credentials issued for that client by its bank.
- Banking connections and credentials are client-scoped, not shared platform credentials.
- A client may have multiple bank connections where supported.
- Credentials must remain encrypted and isolated by client, provider, connection and credential version.
- Tycoon may inspect connection state and operational metadata, but the console must never reveal credential plaintext, tokens, encryption envelopes or other secret material.
- A provider identifier existing in code does not mean that provider is ready for customer use. Current G4 evidence says Co-op is implemented but not operationally verified; KCB, Equity and NCBA are not operational adapters.

### 3.4 M-PESA ownership

The M-PESA ownership model has two distinct layers:

**Tycoon platform layer**

- Tycoon owns and operates the Daraja application used by the Tycoon service.
- Daraja application credentials (`DARAJA_CONSUMER_KEY`, `DARAJA_CONSUMER_SECRET`) and the selected Daraja environment are platform-level configuration.
- Those application credentials are not client credentials and must not be displayed to clients or exposed in the Superadmin UI.

**Client merchant layer**

- Each client has its own merchant Till/shortcode.
- The Till/shortcode identifies that client's merchant account and is stored in a client-scoped `MpesaMerchantProfile`.
- A client's Till must never be represented as Tycoon's own merchant Till merely because Tycoon operates the Daraja application.
- Merchant profiles, callback/pull capability and their readiness belong to the relevant client.

Do not add client-specific M-PESA secrets, passkeys or credential records unless a verified Daraja endpoint contract requires them. The current implementation uses a platform-level OAuth client and does not store a credential reference on `MpesaMerchantProfile`.

**Provider verification boundary:** the design supports Tycoon's platform Daraja application being used with multiple client merchant profiles, but that does not prove Safaricom has authorized the application to operate every client-owned live Till. Multi-merchant authorization, shortcode mapping and merchant eligibility must be verified before an integration is displayed as operational. Never infer that authorization from an OAuth token alone.

The current merchant profile has one optional `estateId`. Do not assume a single Till can be mapped to multiple estates or that receipt allocation is solved by the merchant profile. That mapping is a separate product/data decision.

## 4. Problem statement

The current backend provides a minimal platform control plane: provisioning, client activation/deactivation, platform user listing, audit listing, subscription listing, overview and a basic health response. It does not yet provide the complete operational visibility or Manager workflows required by the agreed model.

The current API does not expose product entitlement assignment, does not classify clients by assigned products, and does not return Banking/M-PESA readiness in client details. Subscription management is read-only from the platform routes. Health can report green without verifying key downstream systems. A Platform Manager therefore cannot reliably answer:

- Which clients have been assigned Banking, M-PESA or both?
- Is the assigned product actually configured and usable?
- Which client Till belongs to which client?
- Which client's bank connection requires reauthorization or has failed?
- Which monthly subscription or trial was assigned, and when does its recorded term end?
- Is a failure local to one client integration, a shared provider, a worker, or platform infrastructure?

## 5. Product goals

1. Give the Platform Manager a clear platform-wide view of clients, products, subscriptions and operational health.
2. Make each client's product assignments explicit and manageable.
3. Show assigned product entitlement separately from configured integration state and operational readiness.
4. Preserve strict client data and credential isolation.
5. Make Banking and M-PESA ownership understandable and auditable.
6. Represent monthly subscriptions and trials honestly without pretending an administrative assignment proves payment.
7. Expose actionable operational failures without exposing secrets or overstating provider readiness.
8. Preserve existing G3 accounting, G4 bank integration and G5 M-PESA ingestion boundaries.

## 6. Non-goals

- Building a customer tenant portal or replacing customer-facing estate workflows.
- Creating a new rent collection, reconciliation, Payment or Ledger engine.
- Automatic subscription billing, payment checkout, invoice automation, recurring charges, collections or grace-period automation.
- Inventing subscription prices, plan features, trial duration or product limits.
- Treating Tycoon's Daraja application credentials as client-owned credentials.
- Storing all clients' bank credentials in global environment variables.
- Treating a configured integration as proof of product entitlement.
- Treating product entitlement as proof that an integration is operational.
- Exposing bank credentials, Daraja secrets, access tokens, encrypted payloads or raw authentication responses.
- Silently impersonating client owners or adding wildcard cross-client business access.
- Rewriting existing G3/G4/G5 systems as part of the console project.

## 7. Proposed information architecture

The console uses the following seven areas. This preserves the previously agreed structure map; it is the baseline, not an invitation to redesign the product from scratch.

1. **Overview** — platform KPIs, client mix by assigned product, subscription/trial overview, integration readiness, worker state and recent critical events.
2. **Clients** — searchable and filterable client directory showing owner, active state, assigned products, plan/term and concise integration indicators.
3. **Client workspace** — one client's profile, owner/users, estates/portfolio counts, Banking, M-PESA, subscription and activity/readiness.
4. **Integrations** — cross-client Banking and M-PESA operational view with failures and pending verification, without secret material.
5. **Subscriptions** — client subscription assignments, plan, monthly dates, trial state and Manager-controlled changes. Payment evidence is shown only where a real transaction record exists.
6. **Users & access** — Platform Managers and customer-side owners/admins/staff with role and client scope.
7. **Audit & system health** — sensitive platform actions, infrastructure health, provider health and background-job outcomes.

### 7.1 Client directory indicators

Each row should make the difference between entitlement and integration visible. For example:

- **Assigned products:** Banking, M-PESA, Both, or None.
- **Banking setup:** Not configured, Pending, Connected, Reauthorization required, Failed, or Not operationally verified.
- **M-PESA setup:** Not configured, Draft, Capability unverified, Active/verified, Suspended, or Blocked.
- **Subscription:** Trial/Basic/Pro, assigned monthly dates, active/inactive service state; payment evidence only when present.

The labels must be derived from the relevant entitlement and integration records. Do not maintain a manually typed summary label that can drift from source records.

## 8. Core user workflows

### 8.1 Create and provision a client

1. The Manager creates a client business record.
2. The Manager creates or assigns the initial client owner.
3. The Manager explicitly assigns Banking, M-PESA, both, or neither.
4. The Manager assigns the subscription plan or trial and its monthly term/date information.
5. The client appears in the directory with its product assignment and setup state.
6. Integration configuration is completed as a separate, visible step; provisioning does not claim that a bank or Till is already connected.

The existing backend currently creates the Client, one owner and one Subscription together, and requires a password in the provisioning request. A safer invitation/setup flow is not currently present and must not be falsely described as implemented.

### 8.2 Manage a client

The Manager can open one client workspace, view its information, update allowed profile fields, activate/deactivate it, inspect assigned products, subscription and integration state, and navigate to scoped operational data.

Sensitive actions must identify the real Manager actor, target client and action in the audit trail.

### 8.3 Manage subscription assignment

The Manager can assign or change the subscription plan, record monthly start/end dates, and mark a trial clearly as a trial. The UI must not display an assigned active subscription as “paid” unless a real subscription payment transaction is recorded.

No automatic payment attempt or invoice is initiated by changing subscription fields.

### 8.4 Inspect Banking

The Manager can see whether a client has bank connections/accounts, the provider, connection state, account validation/capabilities, last successful sync and actionable errors. Secret material remains inaccessible.

### 8.5 Inspect M-PESA

The Manager can see the client's Till/shortcode profile, estate association, callback and pull capability evidence, operational state, recent ingestion results and blockers. Platform Daraja application configuration is shown only as safe configuration/health metadata, never as credentials.

### 8.6 Investigate an operational failure

The Manager can identify whether the failure is platform-wide or scoped to one client/provider/worker, inspect safe diagnostic details and recent attempts, and distinguish `SUCCESS`, `PARTIAL_FAILURE`, `FAILED`, `SKIPPED`, `BLOCKED` and `RUNNING` outcomes. A job that caught an error or skipped work must not appear as a simple success.

## 9. Functional requirements

| ID | Requirement | Priority |
|---|---|---|
| SM-01 | All platform operations require an authenticated `SUPER_ADMIN` | Must |
| SM-02 | Provide platform-wide and explicit selected-client operating modes | Must |
| SM-03 | List clients with search and filters for active state, assigned products, plan and integration readiness | Must |
| SM-04 | Show client owner, portfolio counts, assigned products, subscription and integration summaries in client detail | Must |
| SM-05 | Assign Banking, M-PESA or both explicitly per client | Must |
| SM-06 | Keep product entitlement separate from actual integration configuration/readiness | Must |
| SM-07 | Represent monthly subscription assignment and trial distinctly | Must |
| SM-08 | Never mark a subscription paid without a recorded transaction that proves the payment | Must |
| SM-09 | Show bank connection state without exposing client bank credentials | Must |
| SM-10 | Show client-owned Till/shortcode separately from Tycoon Daraja application configuration | Must |
| SM-11 | Show provider verification and integration blockers truthfully | Must |
| SM-12 | Provide cross-client Banking and M-PESA operational views | Should |
| SM-13 | Show background-job outcome, client/provider scope and latest error safely | Must |
| SM-14 | Record the real Manager actor and target client for sensitive mutations | Must |
| SM-15 | Allow selected-client diagnostics without silently impersonating a customer user | Must |
| SM-16 | Preserve existing G3/G4/G5 processing and client-isolation guarantees | Must |

## 10. Security, privacy and operational requirements

- The platform routes remain protected by authentication and `SUPER_ADMIN` role authorization.
- Every client-scoped query must enforce the selected client boundary server-side. A UI selector is not a security boundary.
- Do not provide `clientId=*`, implicit all-client business endpoints or owner impersonation.
- Never return plaintext credentials, OAuth tokens, credential envelopes, passkeys or provider secrets.
- Avoid exposing raw request/response payloads that contain phone numbers, account data or authentication material. Use redacted diagnostic fields.
- Sensitive changes must be auditable. If audit persistence fails, the failure must be visible and must not be silently treated as a successful, fully-audited operation.
- Platform health must distinguish configuration present, provider reachable, merchant authorized, and integration operational. These are different facts.
- Client deactivation must have one clearly implemented cross-system meaning. The current HTTP middleware blocks inactive clients, but workers do not consistently enforce the same state. Do not claim deactivation fully suspends every integration until worker enforcement is verified.
- Do not expose customer details or credentials through logs, telemetry or error messages.

## 11. Acceptance criteria

The Superadmin baseline is acceptable when:

1. The Manager can identify every client and see its assigned Banking/M-PESA products without inferring them from integration records.
2. A client can be assigned Banking, M-PESA or both.
3. An assigned product with no configured provider connection is shown as assigned but not configured/ready.
4. A client's Till is clearly labelled as that client's merchant identifier; Tycoon's Daraja app remains platform-level.
5. Bank credentials are isolated per client connection and never displayed.
6. A trial is visibly a trial and is never presented as proof of payment.
7. An active subscription assignment is not labelled paid without a real payment transaction record.
8. Monthly subscription dates and Manager actions are visible and auditable.
9. The client workspace is scoped to one selected client and cannot be used to query another client's business data.
10. The operational dashboard distinguishes platform health, provider capability, merchant readiness and job outcome.
11. A partial/failed/skipped/blocked worker run cannot render as unqualified success.
12. The UI and API do not overstate Co-op or Daraja production readiness.
13. Existing G3 financial records and G4/G5 ingestion paths remain authoritative; no second ledger/payment engine is introduced.

## 12. Known backend baseline and gaps

The source snapshot below is verified at `d322374abac0cd35ce205e916de70c453af0eeda`. These are code observations, not completed feature claims.

### Existing platform API

All `/api/v1/platform` routes require authenticated `SUPER_ADMIN`. Current routes include:

- `GET /overview`
- `GET /health`
- `GET /clients`
- `POST /clients`
- `GET /clients/:clientId`
- `PATCH /clients/:clientId`
- client activate/deactivate actions
- `GET /users`
- `GET /audit`
- `GET /subscriptions`

Current client listing only has an active/inactive filter. Client detail returns owner, subscription and portfolio counts but does not include Banking or M-PESA integration summaries. Provisioning creates a Client, one `CLIENT_OWNER` and one Subscription, but accepts no product selection. Platform subscription listing is read-only.

### Existing models

- `Client` currently contains `name` and `isActive`.
- `Subscription` is one per Client and currently contains `plan` (`trial`, `basic`, `pro`), `status` (`active`, `past_due`, `canceled`), `startDate` and optional `endDate`.
- There is no explicit product entitlement field on Client or Subscription.
- Current `subscriptionService.isActive()` is based on status and does not enforce `endDate`.

### Banking

`BankConnection` and separate `BankCredential` records already provide the client-scoped connection and encrypted credential foundation. Preserve this model. Co-op is implemented but not operationally verified; KCB, Equity and NCBA must not be shown as operational merely because their identifiers are present.

### M-PESA

`MpesaMerchantProfile` is client-scoped and stores the client's business shortcode/Till and optional estate association. Daraja application credentials are platform environment configuration used by the process-level OAuth client. No Superadmin merchant credential assignment/rotation API exists. Callback and Pull capabilities must be shown according to evidence, not assumed.

The current provider evidence document says the sandbox OAuth and one C2B v2 registration were tested, but the `174379` and `600987` shortcode relationship is not established; callbacks remain not exposed; Pull registration/query has not been executed for this merchant; merchant Pull eligibility, nominated number, pagination and a Buy Goods Pull fixture remain unverified; G3 posting remains gated.

### Health, workers and audit

- Platform health currently has false-green behaviour: application health is hard-coded healthy and the check does not verify all required SMS provider settings or operational provider capability.
- Worker wrappers can report success when underlying work was partial, caught an error or was skipped; the console needs richer job outcomes.
- Client deactivation is not consistently enforced by every worker.
- Audit writes are best-effort and can fail without failing the underlying mutation; the console must surface audit-write failure and the implementation needs a durable audit policy for sensitive actions.
- No dedicated Superadmin/platform API test files were identified in the static repository inventory. This is not a claim that the whole test suite was executed; no tests were run for this documentation task.

## 13. Explicitly deferred decisions

The following are not prerequisites to document the agreed product baseline and must not be invented during implementation:

- Subscription prices and the feature differences among Basic/Pro.
- Trial duration and exact post-trial access rule.
- Exact access behaviour when a monthly term reaches `endDate`.
- Whether subscription payment transactions are entered manually or imported from a specific account/source, and the exact verification process.
- Any future automated billing or invoicing (out of scope here).
- Safaricom authorization details proving one Tycoon Daraja app can serve each client-owned live Till.
- Whether one client Till maps to one estate or multiple estates.
- The frontend framework/repository. The backend repository is not evidence of a selected frontend stack.

Do not expand these deferred decisions into a payment platform. Keep the first implementation focused on Manager assignment, clear entitlement, client-scoped integrations and truthful operations visibility.