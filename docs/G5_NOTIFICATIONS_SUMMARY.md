# G5 Notifications — Short Engineering Handoff

**Branch:** `fix/g5-public-payment-url`  
**Baseline:** `92e399f19bb4e84eee440b61eff074b68c734020`  
**Scope:** Backend tenant registration SMS, estate identity, complete billing notices, D-5 reminders, stable M-PESA links and payment confirmations.

## Core decisions

- Every automated SMS body is prefixed by the actual `Estate.name` resolved within `{clientId, estateId}`. Do not modify Celcom sender ID.
- Bank-only registration queues one standard welcome/billing SMS and never creates an M-PESA link.
- M-PESA link eligibility requires client MPESA entitlement plus an operational BUY_GOODS_TILL profile with ACTIVE mapping to that tenant's estate. Missing profile does not block bank-only registration.
- Registration creates Tenant, Tenancy and the appropriate SMS outbox row in the existing caller-owned transaction. No external Celcom call occurs in the transaction.
- One tenant-level link per `{clientId, estateId, tenantId}` remains reusable across houses in the estate. Resend reuses the original URL; explicit security rotation is separate. Final estate exit revokes only when there are no active tenancies, unpaid eligible charges or carried credit.
- New raw tokens remain 256-bit. Store HMAC digest plus AES-GCM token envelope; derive a purpose-specific key from the existing dedicated `G5_ENVELOPE_KEYS` keyring with HKDF. Old digest-only links remain valid; recover their token only from matching authenticated historical outbox evidence and verify the digest. Never silently rotate an unrecoverable old link.
- Billing notices queue once per tenant/estate/period after charges and successful credit application. Aggregate every line; missing/invalid data never renders KES 0 or KES NaN.
- Reminders select `RentCharge.dueDate === NairobiToday + 5 days`, once daily at 09:00 Nairobi. Group relevant outstanding lines. Ordinary SMS dispatch has its own 60-second job.
- Bank confirmations use transaction estateId. M-PESA confirmations use canonical receipt estateId.

## Preserve

- G3 Ledger, RentCharge, PaymentAllocation, Tenant credit and full-period eligibility rules.
- G5 protected outbox, provider lease/send-start fencing and no automatic retry of `unknown`.
- Existing `/pay#t=` contract, `G5_PUBLIC_PAYMENT_URL`, CORS, Celcom/Daraja credentials and sender ID.
- Root G4 `PRD.md`/architecture files and historic G5 design docs; this document set is additive.

## Review findings to keep in mind

- Do not nest `mpesaSubmissionLinkService.issue()` inside tenant creation. Use its caller-session provisioning method.
- Do not revoke a tenant link on a single house move/close. A Tenant may own multiple Tenancies and have carried obligations/credit.
- A digest-only token cannot be decrypted. Preserve old links; try authenticated recovery from the matching protected onboarding outbox; otherwise require explicit security rotation.
- Do not send a billing notification when no current RentCharge rows exist or when credit application failed.
- Do not let a daily reminder job become the ordinary SMS queue dispatcher.

## Safety / delivery

Only `fix/g5-public-payment-url` may be changed. Publish via the connected Composio GitHub integration. No branch creation, force push, PR, main merge, Render change, production access, MongoDB download/install or local project replacement. Tests requiring MongoDB replica-set infrastructure must not install a database server; report them as not run if no existing disposable replica set is available.
