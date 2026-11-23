# G5 Notifications — Architecture and Data Flow

**Status:** Owner-approved implementation architecture, 22 November 2026  
**Branch:** `fix/g5-public-payment-url`  
**Baseline:** `92e399f19bb4e84eee440b61eff074b68c734020`

**Implementation checkpoint:** application code reviewed at `8e8cad6343a6911e15f3565dbcbb26cc5917d6a1`; this documentation and API-contract follow-up is included in the same working branch.
## Ownership and data sources

- Estate identity: `Estate.name`, queried with both `clientId` and `estateId`.
- Tenant registration and occupancy: `Tenant` plus exact `Tenancy` rows; mutable `Tenant.houseId` is only a compatibility pointer and is not authoritative where multiple active tenancies are permitted.
- M-PESA eligibility: `checkEntitlement(clientId, 'MPESA')` plus exactly one `BUY_GOODS_TILL` profile in ACTIVE operational state with an ACTIVE `MpesaMerchantProfileEstate` mapping for the same client and estate. The legacy `MpesaMerchantProfile.estateId` field is not authoritative.
- M-PESA link identity: existing unique `{clientId, estateId, tenantId}` `MpesaSubmissionLink`; it is not house- or tenancy-scoped.
- Configured registration plan: the shared House billing resolver; HOUSE_TYPE uses the effective period version or, only when no plan-version history exists, the linked type's canonical `defaultBilling`. Registration does not read or create RentCharges.
- Generated obligations and settlement: `RentCharge`, G3 Ledger/PaymentAllocation and TenantCreditMovement. Use saved `dueDate` for reminders; do not calculate a second due-date policy in SMS code.
- Outbound standard SMS: existing `SmsMessage` STANDARD queue + Celcom adapter. Protected link/receipt SMS: same `SmsMessage` collection with encrypted `G5_PROTECTED` outbox and existing G5 dispatcher.

## Registration transaction

The existing `tenantService.create()` owns one MongoDB transaction and `tenancyService.open()` already accepts the caller's session. Re-read the House and Estate inside that session; create Tenant and Tenancy; resolve the exact House's configured billing plan through the shared House resolver; then evaluate M-PESA entitlement and estate Till mapping in the same scope. Registration must not read generated RentCharge rows or require charge generation to have run.

- Bank-only or non-eligible estate: queue exactly one ordinary `tenant_registration` SMS in the caller's session. No link is created.
- Eligible M-PESA estate: create the link and one encrypted protected onboarding outbox row in the same session. Include registration details and any available bill breakdown in that protected message. Do not also queue a duplicate ordinary welcome SMS.
- Never call Celcom during the transaction. Dispatch only after commit. If a secure REQUIRED M-PESA link/outbox write fails, abort the registration transaction; if the estate is not M-PESA eligible, ordinary registration proceeds without that dependency.
- Use stable Tenant/link/message IDs across transaction callback retries; create a fresh AES-GCM nonce each callback attempt.

## Bank instructions and missing phone

The current `BankAccount` model represents a connected statement-ingestion account; it does not establish that the account is the estate's rent-receiving destination. Do not decrypt or publish it in tenant SMS. Until a dedicated authoritative/verified payment-instruction source is available, the ordinary registration and estate-transfer message tells the tenant to contact the estate office for verified bank details. Tenant phone is optional at API and persistence boundaries. Missing phone does not abort tenant/tenancy registration or a transfer; the SMS is skipped and an audit event records the reason.

## Stable link and encryption

`MpesaSubmissionLink.tokenDigest` remains the constant-time HMAC verification value. Add `tokenEnvelope` with `select:false`. Its format is versioned AES-256-GCM; AAD binds link ID, client ID, estate ID, tenant ID and link version. The encryption key is HKDF-derived from the active `G5_ENVELOPE_KEYS` key using a link-token-specific context. The HMAC pepper is not reused as an encryption key. The root keyring already supports key IDs and previous-key decryption; preserve that rotation behavior.

New link creation stores digest + envelope. Normal `issue` against an ACTIVE link is idempotent and never rotates. Explicit `resend` decrypts the same token, rebuilds `${G5_PUBLIC_PAYMENT_URL}/pay#t=${token}` and queues a new protected attempt with a new message ID and idempotency key; `linkVersion` stays unchanged. Explicit security `rotate` requires the expected current version, creates a new token/envelope/digest and cancels old unsent outbox work. Revoke clears token digest/envelope, increments version and cancels old unsent outbox work.

Old links without encrypted tokens remain valid. Before declaring their token unrecoverable, inspect historical G5 protected onboarding rows for the same link/version; decrypt using the original AAD and verify the recovered token's HMAC digest against `tokenDigest`. Never infer a token or silently rotate. If no authenticated original is available, return a specific recovery error; only an explicit security rotation may replace it.

A successful SMS-evidence submission does not invalidate the link. A tenant may have several active tenancies in the same estate; closing one does not revoke the tenant-level link while another ACTIVE Tenancy remains there. When the final ACTIVE Tenancy in that estate closes, revoke the link in that same tenancy transaction, regardless of unpaid RentCharge balances or carried Tenant credit. A cross-estate transfer closes the old tenancy, revokes the old-estate link if it was the final active occupancy there, then evaluates/provisions the destination-estate link. Never delete historical payments, submissions, receipts or ledger rows.

## Billing notices and money validation

Use a single pure aggregation function over `RentCharge` rows. Every `amountDueCents`, `amountPaidCents`, and `balanceCents` must be a safe integer; invalid/missing input rejects rendering. Aggregate every line by charge type; current outstanding is the sum of positive line balances. Query prior periods separately for prior arrears. No current period charge rows means billing unavailable, not a zero invoice.

`rentStatusJob` continues using existing `rentService.generateChargesForEstate()`. After generation and after each tenant's auto-apply-credit attempt, queue one billing notice per `{clientId, estateId, tenantId, period, notificationVersion}`. Do not notify tenants whose credit application failed on that run. A later successful run can queue the notice because no failed-credit message was inserted. The queue's unique idempotency key prevents duplicates across job instances/restarts.

## Rent reminders and dispatch separation

A reminder is selected only where an open positive-balance `RentCharge.dueDate` falls on the Nairobi calendar date `today + 5 days`. Group by tenant, individual active tenancy, period and Nairobi due-date day; include each charge type's outstanding amount and previous arrears for that tenancy. Do not infer due date from job time or registration time. A stable reminder identity includes tenant, tenancy, period, due date and stage (`D-5`). A unique queue key provides idempotency.

Schedule reminder selection once daily at 09:00 `Africa/Nairobi`. Ordinary SMS queue dispatch is a separate short-interval job (60 seconds); it must not be coupled to reminder generation. Keep existing Redis locks, job metrics and the protected G5 dispatcher. An ordinary SMS queued at registration is therefore not held until the next daily reminder.

## Payment confirmation estate context

Ordinary bank confirmation calls already carry transaction `estateId`; the standard queue resolves the authoritative Estate before enqueuing and prefixes the body. G5 M-PESA confirmation resolves Estate by the canonical receipt's `clientId`/`estateId` inside the posting transaction. Never substitute the tenant's current estate for the receipt's historical estate. Keep protected payload encryption.

## Review: what could break and dispositions

1. **Nested Mongo transactions:** do not invoke the independent public `issue()` from registration. Add a session-aware provisioning method and let the existing registration transaction own the session.
2. **Duplicate welcome messages:** queue one standard SMS for non-M-PESA; one protected SMS for eligible M-PESA. Use deterministic attempt identity.
3. **Tenant has multiple units:** link identity is tenant+estate, not house. Closing one tenancy keeps the link only if another ACTIVE Tenancy remains in that estate. Final active tenancy exit revokes it regardless of retained G3 arrears/credit. A cross-estate move retires the old estate link and provisions the destination estate separately.
4. **Old tokens are digest-only:** impossible to reverse mathematically. Recover only from a matching historical protected outbox envelope and verify HMAC. If not recoverable, fail visibly; never silently invalidate a live URL.
5. **AES-GCM nonce reuse:** generate a fresh nonce for every encryption invocation, including transaction callback retry; AAD includes immutable owner and version identity.
6. **Unknown provider result:** do not automatically resend an ambiguous Celcom attempt. A user-requested separate delivery attempt is allowed only when an operator explicitly requests it; preserve the unknown attempt and reuse the same token.
7. **No generated charges yet:** registration still displays the configured House plan; absence of RentCharge rows is irrelevant to the welcome message. Do not create charges, report a statement balance, prorate, or invent zero. If the selected House source genuinely has no applicable plan, render that source-specific unavailable state.
8. **Reminder spam:** remove the 15-minute reminder cadence and 24-hour cooldown; use exact due-date D-5 selection and idempotency. Queue draining becomes independent.
9. **Historical G4 scope:** root G4 docs remain unchanged; this dedicated G5 contract is additive.
10. **Overengineering:** no new provider, database engine, scheduler dependency, shortener service, wallet, or duplicate financial model. Reuse the current queue, models, keyring, locks and G3 billing.

## API and operator contract

Authenticated G5 link operations are mounted under `/api/v1/mpesa-collection/tenants/{tenantId}/link` and require an authenticated client context, the MPESA product entitlement and a CLIENT_OWNER/CLIENT_ADMIN/SUPER_ADMIN role. The optional `estateId` query parameter selects a specific estate context where the tenant has active tenancies in more than one estate; without it, the compatibility `Tenant.estateId` pointer is used. The backend checks the caller's permitted estate set and requires an active tenancy or an existing estate-scoped link. `POST /link` creates a link when absent or reuses an ACTIVE link; it never returns the bearer token. Reusing an ACTIVE link does not send another SMS. Use `POST /link/resend` for a new protected delivery attempt with the same token/version, or `POST /link/rotate` with `{ expectedLinkVersion }` for an explicit security rotation. `POST /link/revoke` is an explicit administrative revoke. State-changing authenticated requests remain behind the existing CSRF boundary.

The OpenAPI document is `src/docs/openapi.js` and is served at `/api-docs`. The public tenant submission endpoint remains `POST /api/v1/public/mpesa/submissions`; the bearer token is submitted in the body by the existing public-pay page contract.

## Operational constraints

This architecture retains application-level MongoDB transaction requirements already present in the repository. It does not download/install MongoDB, start a local database, modify local project directories, or require production database access. Integration tests requiring a replica set remain unrun unless an already-provisioned disposable test service is available. No Render configuration or deployment is part of this branch patch.
