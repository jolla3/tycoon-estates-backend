# G5 Notifications — Architecture and Data Flow

**Status:** Owner-approved implementation architecture, 22 November 2026  
**Branch:** `fix/g5-public-payment-url`  
**Baseline:** `92e399f19bb4e84eee440b61eff074b68c734020`

## Ownership and data sources

- Estate identity: `Estate.name`, queried with both `clientId` and `estateId`.
- Tenant registration and occupancy: `Tenant` plus exact `Tenancy` rows; mutable `Tenant.houseId` is only a compatibility pointer and is not authoritative where multiple active tenancies are permitted.
- M-PESA eligibility: `checkEntitlement(clientId, 'MPESA')` plus exactly one `BUY_GOODS_TILL` profile in ACTIVE operational state with an ACTIVE `MpesaMerchantProfileEstate` mapping for the same client and estate. The legacy `MpesaMerchantProfile.estateId` field is not authoritative.
- M-PESA link identity: existing unique `{clientId, estateId, tenantId}` `MpesaSubmissionLink`; it is not house- or tenancy-scoped.
- Billing: `RentCharge` and G3 Ledger/PaymentAllocation/TenantCreditMovement. Use saved `dueDate`; do not calculate a second due-date policy in SMS code.
- Outbound standard SMS: existing `SmsMessage` STANDARD queue + Celcom adapter. Protected link/receipt SMS: same `SmsMessage` collection with encrypted `G5_PROTECTED` outbox and existing G5 dispatcher.

## Registration transaction

The existing `tenantService.create()` owns one MongoDB transaction and `tenancyService.open()` already accepts the caller's session. Re-read the House and Estate inside that session; create Tenant and Tenancy; derive current bill text only from valid matching charge records; then evaluate M-PESA entitlement and estate Till mapping in the same scope.

- Bank-only or non-eligible estate: queue exactly one ordinary `tenant_registration` SMS in the caller's session. No link is created.
- Eligible M-PESA estate: create the link and one encrypted protected onboarding outbox row in the same session. Include registration details and any available bill breakdown in that protected message. Do not also queue a duplicate ordinary welcome SMS.
- Never call Celcom during the transaction. Dispatch only after commit. If a secure REQUIRED M-PESA link/outbox write fails, abort the registration transaction; if the estate is not M-PESA eligible, ordinary registration proceeds without that dependency.
- Use stable Tenant/link/message IDs across transaction callback retries; create a fresh AES-GCM nonce each callback attempt.

## Stable link and encryption

`MpesaSubmissionLink.tokenDigest` remains the constant-time HMAC verification value. Add `tokenEnvelope` with `select:false`. Its format is versioned AES-256-GCM; AAD binds link ID, client ID, estate ID, tenant ID and link version. The encryption key is HKDF-derived from the active `G5_ENVELOPE_KEYS` key using a link-token-specific context. The HMAC pepper is not reused as an encryption key. The root keyring already supports key IDs and previous-key decryption; preserve that rotation behavior.

New link creation stores digest + envelope. Normal `issue` against an ACTIVE link is idempotent and never rotates. Explicit `resend` decrypts the same token, rebuilds `${G5_PUBLIC_PAYMENT_URL}/pay#t=${token}` and queues a new protected attempt with a new message ID and idempotency key; `linkVersion` stays unchanged. Explicit security `rotate` requires the expected current version, creates a new token/envelope/digest and cancels old unsent outbox work. Revoke clears token digest/envelope, increments version and cancels old unsent outbox work.

Old links without encrypted tokens remain valid. Before declaring their token unrecoverable, inspect historical G5 protected onboarding rows for the same link/version; decrypt using the original AAD and verify the recovered token's HMAC digest against `tokenDigest`. Never infer a token or silently rotate. If no authenticated original is available, return a specific recovery error; only an explicit security rotation may replace it.

A successful SMS-evidence submission does not invalidate the link. A tenant may have several active tenancies in the same estate; closing one does not revoke the tenant-level link. Only when no ACTIVE Tenancy, no open eligible RentCharge and no carried Tenant credit remains for that tenant/estate may the lifecycle revoke it. Cross-estate transfer retires the old estate link only after checking old-estate obligations/credit. Never delete historical payments, submissions, receipts or ledger rows.

## Billing notices and money validation

Use a single pure aggregation function over `RentCharge` rows. Every `amountDueCents`, `amountPaidCents`, and `balanceCents` must be a safe integer; invalid/missing input rejects rendering. Aggregate every line by charge type; current outstanding is the sum of positive line balances. Query prior periods separately for prior arrears. No current period charge rows means billing unavailable, not a zero invoice.

`rentStatusJob` continues using existing `rentService.generateChargesForEstate()`. After generation and after each tenant's auto-apply-credit attempt, queue one billing notice per `{clientId, estateId, tenantId, period, notificationVersion}`. Do not notify tenants whose credit application failed on that run. A later successful run can queue the notice because no failed-credit message was inserted. The queue's unique idempotency key prevents duplicates across job instances/restarts.

## Rent reminders and dispatch separation

A reminder is selected only where a current open `RentCharge.dueDate` falls on the Nairobi calendar date `today + 5 days`. Group by tenant, period and due date across all relevant Tenancies/houses; include charge breakdown, amount due and separate prior arrears. Do not infer due date from job time or registration time. A stable reminder identity includes tenant, sorted tenancy IDs, period, due date and stage (`D-5`). A unique queue key provides idempotency.

Schedule reminder selection once daily at 09:00 `Africa/Nairobi`. Ordinary SMS queue dispatch is a separate short-interval job (60 seconds); it must not be coupled to reminder generation. Keep existing Redis locks, job metrics and the protected G5 dispatcher. An ordinary SMS queued at registration is therefore not held until the next daily reminder.

## Payment confirmation estate context

Ordinary bank confirmation calls already carry transaction `estateId`; the standard queue resolves the authoritative Estate before enqueuing and prefixes the body. G5 M-PESA confirmation resolves Estate by the canonical receipt's `clientId`/`estateId` inside the posting transaction. Never substitute the tenant's current estate for the receipt's historical estate. Keep protected payload encryption.

## Review: what could break and dispositions

1. **Nested Mongo transactions:** do not invoke the independent public `issue()` from registration. Add a session-aware provisioning method and let the existing registration transaction own the session.
2. **Duplicate welcome messages:** queue one standard SMS for non-M-PESA; one protected SMS for eligible M-PESA. Use deterministic attempt identity.
3. **Tenant has multiple units:** link identity is tenant+estate, not house. Closing/moving one house is not estate exit. Check active tenancies plus G3 arrears and credit before revocation.
4. **Old tokens are digest-only:** impossible to reverse mathematically. Recover only from a matching historical protected outbox envelope and verify HMAC. If not recoverable, fail visibly; never silently invalidate a live URL.
5. **AES-GCM nonce reuse:** generate a fresh nonce for every encryption invocation, including transaction callback retry; AAD includes immutable owner and version identity.
6. **Unknown provider result:** do not automatically resend an ambiguous Celcom attempt. A user-requested separate delivery attempt is allowed only when an operator explicitly requests it; preserve the unknown attempt and reuse the same token.
7. **No bill yet:** partial-period tenancy policy remains unchanged. Registration says the statement is not yet available; do not prorate or invent zero.
8. **Reminder spam:** remove the 15-minute reminder cadence and 24-hour cooldown; use exact due-date D-5 selection and idempotency. Queue draining becomes independent.
9. **Historical G4 scope:** root G4 docs remain unchanged; this dedicated G5 contract is additive.
10. **Overengineering:** no new provider, database engine, scheduler dependency, shortener service, wallet, or duplicate financial model. Reuse the current queue, models, keyring, locks and G3 billing.

## Operational constraints

This architecture retains application-level MongoDB transaction requirements already present in the repository. It does not download/install MongoDB, start a local database, modify local project directories, or require production database access. Integration tests requiring a replica set remain unrun unless an already-provisioned disposable test service is available. No Render configuration or deployment is part of this branch patch.
