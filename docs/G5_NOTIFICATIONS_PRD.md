# G5 Notifications — Product Requirements

**Status:** Owner-approved implementation contract, 22 November 2026  
**Repository:** `jolla3/tycoon-estates-backend`  
**Working branch:** `fix/g5-public-payment-url`  
**Baseline:** `92e399f19bb4e84eee440b61eff074b68c734020`
**Implementation checkpoint:** application code reviewed at `8e8cad6343a6911e15f3565dbcbb26cc5917d6a1`; this documentation and API-contract follow-up is included in the same working branch.

## Product outcome

Tycoon Estates sends accurate, timely messages to tenants, with the estate they actually occupy clearly identified. Notifications must use backend-owned estate, tenancy, billing and payment configuration. A client can manage several estates with different payment arrangements.

## Requirements

1. Every automated SMS body identifies the tenant's actual estate (`Estate.name` resolved by `{clientId, estateId}`). Never use a hardcoded Tycoon brand or a frontend-supplied estate name. Do not change the Celcom sender ID.
2. Tenant registration queues one prompt message in the same lifecycle transaction as Tenant and Tenancy creation. It identifies the estate, tenant and house, confirms registration, and includes only authoritative bill data that exists. When no bill exists, say that billing details are not available yet; never fabricate KES 0.
3. Bank-only tenants receive the registration/billing message and no M-PESA URL. Bank instructions may only be included where an existing verified bank-instruction source is available. Do not invent account details.
4. Include an M-PESA submission link only when the client has the canonical MPESA entitlement and the tenant's estate has exactly one active, operational `BUY_GOODS_TILL` profile through an ACTIVE `MpesaMerchantProfileEstate` mapping. A profile mapped to a different estate does not qualify. Missing Till, phone or public URL must not create an unusable link or block an otherwise valid non-M-PESA registration. An eligible M-PESA provision must atomically create its tenant-level link and encrypted protected-SMS outbox row; failure of that required secure write aborts the same registration transaction.
5. An M-PESA link is tenant-and-estate scoped and reusable while at least one ACTIVE Tenancy remains for that tenant in that estate. Closing one of several active tenancies does not revoke it. Closing the final active tenancy revokes it immediately, regardless of unpaid balances or carried credit; historical financial records remain intact. A same-estate house move does not rotate the link. A cross-estate transfer revokes the old-estate link and evaluates/provisions a distinct destination-estate link. Standard resend uses the exact same URL and does not change `linkVersion`; only explicit security rotation or final estate exit invalidates a live link.
6. The existing bearer token remains 32 CSPRNG bytes (43 base64url characters); do not weaken it or use a third-party shortener. Keep `tokenDigest` for verification. Store a separately purpose-derived AES-256-GCM encrypted token envelope so authorized resend can reconstruct the same URL. Existing G5 `G5_ENVELOPE_KEYS` is the dedicated keyring; derive a link-token-specific subkey with HKDF so token ciphertext is cryptographically domain-separated from protected SMS/evidence ciphertext and from `G5_LINK_TOKEN_PEPPER`. No new provider or external key service is introduced.
7. Legacy active links created before `tokenEnvelope` existed must remain valid. Recover their original token only from a matching, authenticated historical protected onboarding outbox row and verify its digest before sealing it. If no recoverable original exists, do not silently rotate; return an explicit recovery error and require an authorized security rotation.
8. A resend creates a fresh protected delivery attempt with a new message identity/idempotency key but the same token and version. Do not automatically replay provider outcomes marked `unknown`; preserve G5's send-start/lease fencing and manual resolution rule.
9. After billing generation and Tenant credit application, queue at most one complete billing notice per tenant and estate billing period. Aggregate all RENT lines and all utilities/other lines, paid amounts and outstanding amounts. Include previous arrears separately and due date(s). Missing/invalid values or no current charge rows mean no billing notice, not zero.
10. Rent reminders are due-date notices, not a polling/cooldown loop. Select open positive-balance charges whose saved `RentCharge.dueDate` is exactly five Nairobi calendar days ahead. Group by tenant, active tenancy, billing period and Nairobi due-date calendar day so all charge lines for that tenancy/day appear in one message without merging distinct tenancy schedules. Do not send settled charges. Run selection daily at 09:00 Africa/Nairobi and dispatch ordinary SMS independently every 60 seconds.
11. Bank and M-PESA payment confirmations identify the estate attached to the canonical transaction/receipt ownership context. Do not use the tenant's current estate to rewrite historical payment ownership.
12. Provider `sent` continues to mean Celcom accepted the request, not that a handset delivery receipt was observed.
13. A missing tenant phone must not block tenant/tenancy registration or a move; skip the SMS and record the operational reason.
14. The connected BankAccount model is a statement-ingestion account, not proof of a rent-receiving destination. Do not put it in tenant messages. Until an authoritative verified payment-instruction source exists, direct tenants to the estate office for bank details.

## Financial invariants

- G3 `RentCharge`, PaymentAllocation, Ledger, Tenant credit and current configured billing policy remain the financial source of truth.
- Preserve the existing full-period tenancy rule; do not introduce partial-month proration.
- All monetary calculations use non-negative/signed safe integer cents as appropriate. Missing/unsafe values fail closed; never render `NaN`.
- A genuine fully settled bill is distinct from absent billing rows.
- A billing statement can summarize all current-period charge lines across the tenant's tenancies in one estate. A D-5 reminder is scoped to its tenancy and due day. Neither workflow creates a second accounting model.

## Explicit non-goals

- No change to Celcom sender ID or credentials, Daraja credentials/callbacks, CORS allowlist, public `/pay#t=` contract, Render configuration, deployment or production data.
- No new branch, pull request, merge to `main`, MongoDB server download/install, local database setup, new SMS provider, billing engine, token verifier or URL-shortener vendor.
- No frontend application change in this backend-only patch. Add backend resend endpoint; frontend can expose it later.

## Acceptance gates

Cover estate isolation, bank-only registration, eligible M-PESA registration, transaction atomicity, encrypted token persistence, legacy token recovery, stable resend, explicit rotation/revocation, multi-tenancy close behavior, accurate billing aggregation, no false zero/NaN, five-day reminder date selection, scheduler separation, payment confirmation estate context and G3/G4 regressions. Do not claim integration tests passed unless they actually run against the repository's disposable replica-set test database.
