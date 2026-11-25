# G5 Notifications — Short Engineering Handoff

**Branch:** `fix/g5-public-payment-url`
**Baseline:** `92e399f19bb4e84eee440b61eff074b68c734020`
**Scope:** Backend tenant registration SMS, estate identity, complete billing notices, D-5 reminders, stable M-PESA links and payment confirmations.
**Implementation checkpoint:** application code reviewed at `8e8cad6343a6911e15f3565dbcbb26cc5917d6a1`; this documentation and API-contract follow-up is included in the same working branch.

## Core decisions

- Every automated SMS body is prefixed by the actual `Estate.name` resolved within `{clientId, estateId}`. Do not modify Celcom sender ID.
- Registration queues one standard or protected welcome SMS using the exact House's configured plan, never generated RentCharge rows. HOUSE_TYPE uses its effective version, or canonical `defaultBilling` only when no plan-version history exists. A linked legacy HouseType remains resolvable; no charge generation is triggered by registration.
- Registration copy uses readable capitalization and a separate line for each configured charge; it does not expose internal source enums or due-day values. Normal charge-generation due-day rules remain intact.
- Bank-only registration queues one standard welcome/billing SMS and never creates an M-PESA link.
- M-PESA link eligibility requires client MPESA entitlement plus an operational BUY_GOODS_TILL profile with ACTIVE mapping to that tenant's estate. Missing profile does not block bank-only registration; the non-eligibility reason is recorded without logging secrets.
- Registration creates Tenant, Tenancy and the appropriate SMS outbox row in the existing caller-owned transaction. No external Celcom call occurs in the transaction.
- Authorized tenant detail and global SMS history show the exact protected message, full M-PESA payment URL and destination number; the encrypted payload envelope remains hidden.
- Registration links require M-PESA entitlement and an estate-mapped Buy Goods Till; DRAFT/NOT_READY profiles can collect evidence, but matching/posting waits until ACTIVE. SUSPENDED/unmapped profiles and PAYBILL profiles do not receive the Till link.
- Disabling protected SMS dispatch suppresses delivery but still saves the eligible link/message for inspection. Suppressed rows are never auto-sent later; explicit resend is required.
- One tenant-level link per `{clientId, estateId, tenantId}` remains reusable while at least one ACTIVE Tenancy remains in that estate. Closing the final active tenancy revokes it regardless of arrears/credit. Same-estate moves preserve it; cross-estate transfers revoke the old estate link and evaluate a destination link. Resend reuses the original URL; explicit security rotation is separate. The API never returns the raw bearer token.
- New raw tokens remain 256-bit. Store HMAC digest plus AES-GCM token envelope; derive a purpose-specific key from the existing dedicated `G5_ENVELOPE_KEYS` keyring with HKDF. Old digest-only links remain valid; recover their token only from matching authenticated historical outbox evidence and verify the digest. Never silently rotate an unrecoverable old link.
- Billing notices queue once per tenant/estate/period after charges and successful credit application. Aggregate every line; missing/invalid data never renders KES 0 or KES NaN.
- Reminders select open positive-balance charges where saved `RentCharge.dueDate` is exactly Nairobi today + 5 days, once daily at 09:00 Nairobi. Group by tenant, tenancy, period and Nairobi due-date day. Ordinary SMS dispatch has its own 60-second job.
- Bank confirmations use transaction estateId. M-PESA confirmations use canonical receipt estateId.

## Preserve

- G3 Ledger, RentCharge, PaymentAllocation, Tenant credit and full-period eligibility rules.
- G5 protected outbox, provider lease/send-start fencing and no automatic retry of `unknown`.
- Existing `/pay#t=` contract, `G5_PUBLIC_PAYMENT_URL`, CORS, Celcom/Daraja credentials and sender ID.
- Root G4 `PRD.md`/architecture files and historic G5 design docs; this document set is additive.

## Review findings to keep in mind

- Do not nest `mpesaSubmissionLinkService.issue()` inside tenant creation. Use its caller-session provisioning method.
- Do not revoke a tenant link when one of several active same-estate tenancies closes. Revoke on final active tenancy exit regardless of retained arrears/credit.
- A digest-only token cannot be decrypted. Preserve old links; try authenticated recovery from the matching protected onboarding outbox; otherwise require explicit security rotation.
- Do not send a billing notification when no current RentCharge rows exist or when credit application failed.
- Do not let a daily reminder job become the ordinary SMS queue dispatcher.

## Verification state

JavaScript syntax checks and focused DB-free smoke/static checks passed for the published implementation slices, including token-envelope cryptography and integer-cent billing aggregation. Focused Jest tests were added but the full Jest suite was not run. MongoDB replica-set integration tests were not run because no already-provisioned disposable replica set was available; no MongoDB was installed or downloaded.

## Safety / delivery

Only `fix/g5-public-payment-url` may be changed. Publish via the connected Composio GitHub integration. No branch creation, force push, PR, main merge, Render change, production access, MongoDB download/install or local project replacement. Tests requiring MongoDB replica-set infrastructure must not install a database server; report them as not run if no existing disposable replica set is available.
