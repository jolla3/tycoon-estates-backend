# G5 — M-PESA Buy Goods / Till Rent Receipt Attribution

**Document:** Product Requirements Document  
**Feature:** G5  
**Document state:** Revised G5.0 design baseline for independent review  
**Repository:** `jolla3/tycoon-estates-backend`  
**Source-audit snapshot:** `main` at `204c8f9c3578f753af20727799aaa049b1545135` (12 November 2026)  
**Implementation state:** Not implemented. This PRD does not claim that any G5 model, route, worker, migration, or test exists.

> **Document authority:** This PRD defines the intended product behaviour. `architecture.md` records the repository design and implementation constraints. `architecture-summary.md` is the short reading map. `G5_IMPLEMENTATION_GUARDRAILS.md` governs how an engineering agent must review and implement the feature. If a source-code fact, provider contract, or merchant-specific capability is not verified, it is a blocker, not an invitation to invent an answer.

---

## 1. Product summary

G5 enables a Tycoon Estates client to accept ordinary customer-to-merchant M-PESA Buy Goods / Till payments for rent and attribute each verified receipt to the intended Tenant, then preserve tenancy-specific accounting for each rental unit.

A Buy Goods customer payment does not provide the dependable tenancy/account reference that is available in many PayBill workflows. The Till receives the money, but a receipt alone does not identify the tenant's house or tenancy. G5 solves the attribution problem without changing the client's collection channel:

1. Tycoon maintains one Tenant profile for the person within the client/Estate. That Tenant may have one or multiple active Tenancies in different Houses in that Estate.
2. Tycoon creates one private Tenant-level submission link. A single-unit Tenant sees one rental account; a multi-unit Tenant sees one combined statement across their eligible rental obligations.
3. Tycoon sends Till instructions and the Tenant-level link through the existing SMS delivery infrastructure. The existing SMS sender/provider configuration remains unchanged.
4. The tenant or a third-party payer makes an ordinary Buy Goods payment and submits the complete M-PESA confirmation SMS once through the Tenant-level link.
5. Tycoon parses that SMS as untrusted evidence and independently verifies it against merchant-side Daraja C2B data.
6. The canonical receipt is claimed once for the Tenant. G3 posts tenancy-scoped payment portions and retains any surplus as Tenant-account credit for future rent.

The link establishes the intended tenancy. The Daraja record establishes that the merchant received a transaction. The submitted SMS supplies the receipt reference that joins those two facts. None of those pieces alone is sufficient to post rent.

**Money remains in the merchant's Buy Goods Till.** G5 records and attributes the tenant payment; it does not move funds, withdraw funds, or settle the Till into a bank account.

## 2. The problem and the rejected shortcuts

The product needs to solve the absence of an ordinary tenancy reference on the Buy Goods customer payment. It must not pretend the missing reference exists.

The following are not safe attribution rules and must never be used as automatic fallbacks:

- Guessing from the amount. Different tenants can pay the same rent or partial amount.
- Guessing from payer phone number. A relative, employer, agent, or other third party may pay.
- Guessing from the tenant's current house or the house's current occupant. Those pointers change when a tenant moves.
- Guessing from payment date and the current tenancy. A former tenant can pay arrears after moving out.
- Treating a forwarded, edited, or typed SMS as proof that money reached the merchant.
- Treating a callback alone as proof of which tenancy should be credited.

Ambiguity must lead to a pending or review state. It must not lead to a best guess.

## 3. Product goals

- Accept customer-to-merchant Buy Goods / Till rent payments for enabled merchant profiles.
- Bind every submission link to one immutable Tenant identity within its client/Estate; resolve the Tenant's eligible Tenancies only after token validation.
- Permit third-party payment without requiring payer MSISDN equality with the tenant's registered phone.
- Parse the customer's M-PESA confirmation SMS deterministically.
- Independently confirm receipt against actual Daraja C2B records.
- Converge callback and Pull Transactions ingestion on one canonical transaction identity.
- Ensure one external receipt is claimed once, and that all tenancy-scoped G3 postings plus any carried-forward Tenant credit exactly reconcile to the verified receipt amount.
- Post through G3 `Payment`, `PaymentAllocation`, `RentCharge`, and `Ledger` only.
- Preserve old-tenancy debt and stop old-tenancy credit from being transferred to a later occupant.
- Provide a secure manual-review path for ambiguity, provider gaps, conflicting claims, and unverified historical balances.
- Leave existing PayBill and G4 bank reconciliation behaviour unchanged.

## 4. Explicit non-goals

G5.0/G5 initial delivery does not:

- Redesign, replace, or modify the existing PayBill reference/account-number workflow. PayBill is not the problem being solved.
- Add STK Push or initiate a customer payment on the tenant's behalf.
- Add outbound B2B Buy Goods, B2C payouts, withdrawals, reversals, merchant settlement, or a Till-to-bank transfer flow.
- Treat a Till transaction as a bank transaction or repurpose G4 `BankTransaction`, `BankAccount`, or `BankConnection` records.
- Introduce a parallel rent ledger, second Payment model, new balance authority, or second allocation algorithm.
- Require a tenant dashboard or tenant login for receipt submission.
- Use an LLM to parse a known M-PESA SMS template.
- Automatically move unapplied credit from one tenancy to another.
- Automatically post a payment based only on an SMS, a link visit, a payer identity, or an unverified callback payload.

A future merchant withdrawal/bank-credit reconciliation is a separate merchant-settlement feature. It must not create another tenant Payment for money already recorded by G5.

## 5. Actors and responsibilities

| Actor | Responsibility |
|---|---|
| Client admin / authorized property staff | Configure the merchant mapping, monitor readiness, and review unresolved claims within their client/estate permissions. |
| Tenant | Receives Till instructions and can submit a payment confirmation. |
| Third-party payer | Can make the payment and can submit the confirmation using the tenant's link. Payer identity is not the tenancy key. |
| Safaricom Daraja | Supplies merchant-side C2B transaction data according to the merchant's actual enabled product and API contract. |
| Tycoon worker | Ingests callbacks/pull results, reconciles evidence, retries safe processing, and reports provider gaps. |
| G3 accounting | Owns the actual rent Payment, allocations, charge projections, ledger movement, and balances. |

## 6. Primary product journey

1. A client admin provisions a Buy Goods / Till merchant configuration and completes any required Daraja onboarding/registration outside Tycoon.
2. Tycoon verifies that the merchant configuration is scoped to the correct client and permitted estate/store context. It is not marked operational until the actual Till's capability and provider contract are demonstrated.
3. A tenant is added to a house. G3 creates the Tenant and immutable ACTIVE Tenancy.
4. When trusted server-side G5 provisioning is `REQUIRED` and exactly one permitted operational merchant profile resolves for that tenancy, G5 creates a private link bound to that exact Tenancy and a protected notification-outbox item in the same MongoDB transaction. When provisioning is `DISABLED`, G3 tenancy creation proceeds without G5 records.
5. After commit, the existing SMS dispatcher sends Till instructions and link through the existing provider abstraction. The provider call never runs inside the retryable MongoDB transaction.
6. Tenant or third-party payer makes an ordinary Buy Goods payment to the displayed Till.
7. The full confirmation SMS is submitted through the private link. G5 stores the evidence under the defined privacy/retention policy.
8. The merchant-side Daraja callback and/or Pull Transactions feed provides a canonical record of the receipt. Callback and pull can arrive in either order and can overlap.
9. G5 matches the submission to the canonical receipt within the same verified merchant profile and validates amount, transaction type, time, merchant identity, and tenancy scope.
10. A single claim is acquired with a fenced processing token. G5 invokes the shared G3 posting service using `origin: 'MPESA'` and the canonical internal `MpesaTransaction._id`.
11. G3 creates the Payment, allocations, charge updates, and Ledger PAYMENT movement atomically. The claim/transaction posting state is committed in the same MongoDB transaction.
12. Any mismatch, unsupported payload, duplicate/conflicting claim, unknown merchant, or unverified historical balance remains pending or enters authorized review. It is never silently assigned elsewhere.

## 7. Functional requirements

### FR-01 — Merchant configuration and scope

- A merchant profile is separate from G4 bank connections and bank credentials.
- Store the actual customer-facing Till identifier separately from Store Number, Head Office number, Notification Number, Nominated Number, and any other provider identity fields.
- The profile must carry an explicit client ownership boundary and an explicit allowed estate/store mapping.
- Do not assume one Till equals one estate, or that one Till can safely serve multiple estates. The supported mapping must be verified against the client's actual Safaricom account hierarchy and transaction payloads before automatic posting is enabled.
- Record sandbox/live enablement and callback/pull registration/readiness independently. A configured profile is not necessarily an operational profile.
- Do not expose a ready state until controlled evidence proves that the exact merchant configuration can produce and recover the required C2B records.

### FR-02 — Tenant-level private link

- Generate at least 256 bits of cryptographically secure randomness.
- Persist only a one-way token hash or keyed lookup digest in `MpesaSubmissionLink`.
- Bind the link to immutable `{ clientId, estateId, tenantId }`; do not bind it to one House or Tenancy.
- Never derive the Tenant identity from mutable `Tenant.houseId`, `Tenant.status`, `House.tenantId`, or a current-occupant query. Resolve all eligible Tenancies from the validated Tenant identity.
- Adding another House or moving one unit does not create or retarget the Tenant-level link. The same link remains associated with the same Tenant.
- Keep the link while the Tenant has eligible rental obligations or carried-forward credit. The secret itself must be revocable/rotatable after compromise.
- The token is a bearer credential for the Tenant account, not proof of the submitter's human identity.
- For one active Tenancy the page shows one account; for multiple active Tenancies in the same Estate it shows the combined account total.
- Invalid token responses must not disclose tenant, house, balance, estate, or link-existence information.

### FR-03 — SMS onboarding and secret handling

- Create the protected outbound notification item atomically with the Tenant's first G5-provisioned lifecycle transaction only when trusted G5 provisioning is `REQUIRED`. Subsequent Tenancy additions retain the same Tenant link; any unit-specific notification may reference that same link.
- A `REQUIRED` operation must resolve exactly one permitted operational merchant profile and have valid G5 outbox encryption readiness; otherwise abort the whole lifecycle transaction. Never silently create a Tenant/Tenancy without its required link/outbox.
- Do not call Celcom or any external SMS provider while the MongoDB transaction is open. The transaction callback may be retried; preallocate stable identifiers, token/version and idempotency key, pin the outbox key version, and generate a fresh GCM nonce/envelope inside each callback attempt after session-bound merchant validation. Never reuse a nonce/key pair across retries; perform no external side effect in the callback.
- Reuse the existing SMS provider/worker boundary. Do not create a parallel SMS platform or a sixth G5 domain aggregate without concrete evidence that `SmsMessage` cannot safely carry protected delivery.
- The bearer URL must not be stored in ordinary plaintext `SmsMessage.message`, tenant details, SMS history, audit metadata, structured logs, error telemetry, or provider response logs.
- Extend `SmsMessage` with `deliveryMode: G5_PROTECTED`, dedicated `type: g5_onboarding_link`, `notificationVersion: g5_onboarding_link:v1`, and a versioned authenticated-encryption envelope. Keep the ordinary `message` field a non-secret placeholder and do not expose the actual destination or bearer URL in ordinary fields. Add the new type to the existing strict enum. Use a dedicated G5 outbox keyring; do not reuse the current unversioned encryption helper or bank-only credential keyring unchanged.
- Bind authenticated associated data to immutable message, client, estate, tenant, link, token-version, type and idempotency identities. A notification may additionally carry a specific unit context, but that context does not change link ownership. Default queries/serializers/history/tenant detail must exclude the envelope; decrypt only immediately before the provider call.
- Use a session-aware enqueue operation with the caller-owned Mongo session and existing unique SMS idempotency barrier. The current `queueSms()` and `withIdempotency()` helpers cannot be called unchanged because they do not accept a session.
- Do not blindly retry a provider outcome of `unknown`; the first send may have succeeded. Expired pre-send leases may be reclaimed only if `sendStartedAt` is absent and the link/version remains eligible. Any expired/in-flight attempt with `sendStartedAt` becomes `unknown`, never automatically queued. Define a safe operator recovery path before production.

### FR-04 — SMS evidence submission

- Accept the complete M-PESA confirmation SMS. Do not accept a receipt number alone as equivalent evidence for the automatic flow.
- Parse receipt number, amount, transaction time, merchant/Till fields where present, payer name/phone where present, and parser version.
- Store raw SMS only encrypted and only for a specifically approved retention period. The retention period and authorized visibility are production blockers, not developer guesses.
- Store a digest and normalized allowlisted fields for reconciliation. A digest alone is not a substitute for raw evidence when dispute policy requires the original SMS.
- Treat all submitted content and parsed fields as untrusted until matched to Daraja.
- Deterministic parser only. Unsupported, truncated, malformed, or ambiguous templates must be rejected or placed in review, not heuristically parsed.
- Repeated submission of the same receipt/evidence must be idempotent.
- Third-party payer phone/name may differ from the tenant's details. Do not reject solely for that reason.

### FR-05 — Daraja callback ingress

- Callback routes must be mounted in the public webhook boundary, outside cookie/CSRF middleware, with dedicated request validation and abuse controls.
- Resolve client/merchant ownership from the provider identity using a verified profile mapping. Never accept client/estate identity from an arbitrary callback field.
- Persist a durable callback inbox/quarantine item before acknowledging receipt as successfully handled.
- A malformed or unknown merchant event may be acknowledged only after durable quarantine according to the verified Safaricom callback contract. If it cannot be durably recorded, return a retryable failure according to that contract.
- Do not invent HMAC signatures, Basic authentication, IP ranges, mTLS, or callback acknowledgment semantics. Implement only controls confirmed for the actual Daraja product and merchant onboarding. HTTPS, endpoint entropy, schema validation, and transaction verification remain necessary but are not provider authentication by themselves.

### FR-06 — Pull Transactions recovery

- Register the actual merchant identity as required by the verified Daraja product.
- Pull C2B transaction records on a schedule selected from observed service limits and operational requirements.
- Use bounded overlapping windows and explicit pagination/checkpoints if the provider supports them.
- Callback and pull results must pass through the same normalization and canonical-upsert path.
- Never advance a checkpoint past records that have not been durably ingested or quarantined.
- The publicly mirrored documentation describes a 48-hour query horizon, but that is a release-gate fact to confirm in the authenticated portal and controlled sandbox. Do not treat it as a guaranteed current entitlement or backfill capability.
- Alert before a merchant's recovery window can expire. A missed horizon must be reported as a potential reconciliation gap, not hidden by advancing a checkpoint.

### FR-07 — Evidence verification and claims

Automatic posting requires all of the following:

- Exact receipt-number match.
- Exact integer-cent amount match.
- Canonical transaction belongs to the merchant profile resolved for the Tenant-level link and the verified client/Estate mapping.
- Merchant identity dimensions returned by Safaricom match the configured profile and allowed estate/store mapping.
- Transaction is a customer-to-merchant credit supported by the verified payload schema, not a debit, reversal, B2B, or unrelated movement.
- Timestamp falls within a tolerance established using actual sandbox fixtures and documented provider semantics. No arbitrary tolerance may be invented.
- The validated Tenant-level link still belongs to the claimed Tenant and merchant/client/Estate scope.
- No other claim has already successfully claimed or posted the same canonical receipt.

Payer MSISDN equality is deliberately not a requirement. Any material conflict or unknown field needed to establish merchant or transaction identity moves the claim to review.

### FR-08 — G3 payment posting

- Use `Payment.origin = 'MPESA'`.
- `Payment.mpesaReceiptId` is an ObjectId reference to the internal canonical `MpesaTransaction._id`. It is never the external alphanumeric receipt string.
- Extend the shared G3 accounting path to post receipt portions against exact Tenancies and to preserve any multi-unit surplus as G3-owned Tenant-account credit. Do not call the staff-only MANUAL path or implement a parallel ledger.
- Persist the external receipt number in an appropriate display/reference field only after confirming the existing G3 field semantics and validation limits.
- Idempotency is based on the canonical internal transaction identity and is protected by MongoDB uniqueness plus transactional checks.
- A retry that finds an existing Payment must validate its full merchant transaction, tenant, house, estate, tenancy, amount, date, origin, and allocation scope before reporting success.
- All child Payment records, PaymentAllocation rows, charge projections, tenancy Ledger movements, any Tenant-account credit movement, and claim/transaction POSTED state must commit or roll back together in one MongoDB transaction.
- Existing BANK and MANUAL posting callers and behavior must remain unchanged.

### FR-09 — Closed-tenancy arrears

A verified payment submitted through the Tenant-level link may settle eligible obligations belonging to that Tenant's active or closed Tenancies within the same Estate. The exact Tenancy and its existing eligible charges are selected by G3's approved aggregate allocation policy; the link itself does not select one House.

- Every allocation records the exact `tenancyId`, house, client and estate of its target `RentCharge`.
- Closed Tenancies may receive payment only against pre-existing eligible charges; no new rent charges or billing periods are generated for a closed Tenancy.
- A move closes only the selected Tenancy; it does not close another active Tenancy owned by the same Tenant.
- Do not invoke G4's date-based `tenancyContains(paymentDate)` rule for this link-bound arrears case. Do not change that shared rule or G4 bank reconciliation.
- Any amount above the Tenant's current eligible obligations remains the Tenant's carried-forward rent credit. It reduces future combined rent due for that same Tenant within the same Estate; it is not refunded, forfeited, or assigned to another Tenant.
- For a multi-unit Tenant, this requires an auditable G3 Tenant-account credit/application mechanism because current G3 balances are Tenancy-scoped and do not net credits across Tenancies. G5 must not invent a separate wallet or assign the credit to an arbitrary House.
- G3 must record the original verified receipt, remaining credit and each later application to an exact Tenancy/RentCharge. Credit is applied to future obligations using the deterministic aggregate allocation policy.
- A closed link may become `SETTLED` only when G3 historical financial coverage is verified, all eligible obligations are resolved, no unapplied credit remains unresolved, and no pending/conflicting claims remain. If coverage is `UNVERIFIED`, keep the link non-terminal and require an authorized review. Never infer settlement from a zero cached projection alone.

### FR-10 — Manual review and audit

- Review endpoints are authenticated, role-authorized, and scoped by the existing client/estate context.
- Reviewers can inspect mismatches, unknown merchant identities, duplicate claims, unsupported SMS, delayed/missing provider records, and historical ledger uncertainty.
- A manual association/override requires explicit permission, a recorded reason, an immutable before/after audit trail, and a second approval where the eventual financial-risk policy requires it.
- Manual review must still use the canonical M-PESA transaction and shared G3 posting path.
- Phase one must not silently bypass the two-evidence rule (submitted SMS plus merchant-side Daraja record). Any proposed admin-only exception for a receipt without SMS is a separate product/security decision and must be explicitly approved before implementation.
- A reviewer cannot associate a receipt already posted to another tenancy with a second Payment.

### FR-11 — Atomic tenancy lifecycle and no-send seed policy

- G5 link/outbox creation joins the exact Tenant/Tenancy transaction. A failure in a required link, protected payload, outbox or critical audit write rolls back the full lifecycle mutation.
- A move closes only the selected Tenancy and creates its replacement as configured; the Tenant-level link is retained. Other active Tenancies and the Tenant's other rental accounts remain unchanged. Same-house move is a no-op.
- Move-out closes only the exact `expectedTenancyId` in one transaction. The Tenant-level link remains active while another ACTIVE Tenancy or eligible balance/credit exists. Tenant-wide status is updated only after considering all ACTIVE Tenancies.
- Low-level `tenancyService.open()` must not implicitly send or create a link; seed and other non-operational callers must explicitly opt out of G5 provisioning.
- Demo SMS history must be explicitly suppressed and excluded by the worker claim query. A comment saying “not sent” is not a safety control.
- The live worker must fence claims/outcomes by a dispatch lease token. Stale pre-send work can be reclaimed only before `sendStartedAt`; post-start expiry is ambiguous and must become `unknown`.
- `SmsMessage.status = sent` means provider accepted the message; it does not prove handset delivery.

## 8. Non-functional requirements

- **Financial integrity:** Financial writes require MongoDB transactions and verified replica-set/sharded transaction support.
- **Idempotency:** Callback duplicates, pull overlap, SMS resubmission, retry, and concurrent claims create at most one canonical transaction, winning claim association, Payment, and Ledger PAYMENT effect. This guarantee is conditional on the provider receipt uniqueness scope being proven and its exact unique index passing runtime readiness; while B01/B02 are unresolved, duplicate candidates are quarantined and must not post.
- **Concurrency:** Use MongoDB unique constraints, conditional updates, and fenced claim tokens. Redis locks coordinate workers only; Redis is not financial truth.
- **Isolation:** Scope by client, merchant profile, allowed estate/store mapping, and exact tenancy. Never trust user-supplied ownership identifiers.
- **Confidentiality:** Hash-only link storage; encrypted temporary outbound payload; raw SMS retention policy; log/request-trace redaction; least-privilege decryption.
- **Public endpoint safety:** No tenant PII or account details before bearer validation; no third-party analytics; `Cache-Control: no-store`, `Referrer-Policy: no-referrer`, restrictive CSP, rate limits, and bounded request size.
- **Time:** Persist UTC instants. Interpret merchant/customer display timestamps using verified Safaricom formatting and `Africa/Nairobi` business context. Do not convert ambiguous timestamps silently.
- **Operations:** Provider health, callback delay, pull checkpoint age, claim age, SMS `unknown` delivery, and index readiness must be observable without exposing secrets or payer message contents.
- **Compatibility:** Existing PayBill, G3 BANK/MANUAL flows, and G4 bank reconciliation must remain unchanged except for narrowly reviewed shared-service extensions needed to add MPESA.

## 9. Acceptance criteria

G5 is not production-ready until evidence demonstrates all of the following:

1. Tenant + Tenancy + link + durable protected notification item commit or roll back together.
2. External SMS sending occurs only after the database transaction commits.
3. Adding/moving a House does not create another Tenant-level link. A move changes only the selected Tenancy; the same Tenant link remains bound to the same person.
4. A revoked/rotated token cannot be used, and token-bearing content is absent from ordinary database/API/history/log surfaces.
5. A third-party payer can submit the receipt without matching the tenant phone number.
6. A fabricated or edited SMS with no matching Daraja record cannot create a Payment.
7. Callback and Pull copies of the same receipt converge to one canonical `MpesaTransaction` only after B01/B02 establish the provider receipt identity scope and its unique index is installed and runtime-verified; before that, ambiguous/duplicate candidates remain quarantined and non-postable.
8. A transaction arriving before the SMS and an SMS arriving before the transaction both converge safely.
9. A receipt submitted repeatedly through the Tenant-level link cannot create duplicate claims or child Payments. A receipt already claimed for the Tenant cannot be reassigned.
10. Concurrent submissions, callbacks, pulls, worker retries, and claim lease takeover produce one canonical Tenant claim. For a combined receipt, child Payments per Tenancy plus Tenant-account credit exactly reconcile to the receipt amount.
11. Payment/allocation/charge/Ledger/claim state is atomic under injected failures.
12. BANK and MANUAL G3 regression suites pass unchanged.
13. A closed-tenancy late payment allocates only to existing old-tenancy charges, creates no new charges, and does not reduce the new tenancy balance.
14. An overpayment is retained as credit on the old tenancy or sent to controlled review if G3 cannot safely represent it; no credit is lost or transferred.
15. The old link is not marked SETTLED while historical ledger coverage is unverified or claims/credit remain unresolved.
16. Exact Daraja callback, registration, pull, pagination, acknowledgement, merchant-identity, and timestamp behaviour is demonstrated using the actual authenticated portal and controlled sandbox fixtures.
17. Live merchant readiness is confirmed for the actual Till/Store/Head Office configuration. Public documentation alone is insufficient.
18. All financial tests use a dedicated disposable `tycoon_test_*` MongoDB replica-set/sharded test database and the repository's explicit destructive-test safeguards.
19. Existing G3 and G4 regression suites pass.
20. MPESA posting is fail-closed if canonical `{ merchantProfileId, receiptNumber }` uniqueness is unresolved, duplicate candidates exist, or the exact live unique index/readiness check is missing or misaligned. A multi-unit receipt may produce multiple child Payments, one per Tenancy, so G3's internal Payment index must be unique on `{ mpesaReceiptId, tenancyId }` after migration.
21. In G5 `REQUIRED` mode, Tenant, Tenancy, link, protected outbox and critical lifecycle audit either commit together or roll back together.
22. G5 `DISABLED` mode preserves normal G3 lifecycle behaviour and creates no new link/outbox; any existing link for a Tenancy being closed/transferred must still receive its required lifecycle transition. `REQUIRED` mode fails closed when merchant mapping, operational capability, unique-index readiness or outbox encryption readiness is unavailable.
23. Move, move-out and any future close/void path serialize lifecycle, link state and protected outbox transitions in one Mongo transaction; a same-house move creates no duplicate link or SMS.
24. Token rotation/revocation immediately invalidates the old bearer secret after commit. Queued old-version notices are cancelled; a message already past `sendStartedAt` may still arrive but its token is no longer redeemable.
25. An expired processing lease before `sendStartedAt` can be safely reclaimed only after link/version validation; expiry after `sendStartedAt` produces `unknown` and cannot trigger blind resend.
26. Demo/test SMS fixtures are explicitly suppressed and cannot be claimed by the live Celcom dispatcher.
27. Tenant detail exposes `activeTenancies[]` with exact tenancy/house/estate IDs and tenancy-scoped balances. Move/move-out requests carry the exact `expectedTenancyId` they intend to change; stale/replayed requests cannot mutate another Tenancy or clear a later occupant's House pointer.
28. Protected SMS records use an explicit `g5_onboarding_link` message type and `g5_onboarding_link:v1` notification version; their outbox idempotency key is derived from `linkId + tokenVersion + notificationVersion + preallocated SmsMessage._id` and protects the prepared database attempt, not Celcom request idempotency.
29. Critical lifecycle audit records include the authenticated initiating actor and commit in the same Mongo transaction.
30. Destination House pointer conflicts and old-House `matchedCount !== 1` fail closed; no House pointer is overwritten or cleared without matching the exact expected Tenant/Tenancy.

31. Generic House PATCH cannot mutate the occupancy projection (House.status); House deactivation is rejected while an ACTIVE Tenancy or non-null tenant pointer exists. Only the tenancy lifecycle transaction writes House occupancy state.
32. Generic Tenant PATCH cannot set status active without creating a new ACTIVE Tenancy. Any future reactivation must be a separate atomic lifecycle operation.
33. tenancyService.open() revalidates exact Tenant, House and Estate in the same session; the target House must be active, vacant and have no ACTIVE Tenancy; the same Tenant may have other ACTIVE Tenancies in different Houses in that Estate.
34. One Tenant may have multiple ACTIVE Tenancies in different Houses within the same Estate. Do not create or install a unique partial `{ clientId, tenantId }` ACTIVE-Tenancy index. Retain the per-House unique index.
35. Demo seed Houses begin vacant and are marked occupied only inside the committed Tenant/Tenancy lifecycle operation. Seed code does not manufacture an occupied House before an occupant exists.

## 10. Blocking decisions and provider evidence required

The following must be resolved before the relevant implementation slice is allowed to proceed. They must not be filled in by an agent's best guess.

| ID | Decision / evidence | Why it blocks | Safe default while unresolved |
|---|---|---|---|
| G5-B01 | Actual merchant hierarchy: whether this Till maps to one estate, several estates, or multiple Store identities; exact shortcode/Till/Store/Head Office/Notification/Nominated semantics | Determines transaction ownership and whether a Till receipt can map to the correct profile/store | Disable automatic posting for ambiguous merchant scope. |
| G5-B02 | Authenticated Daraja sandbox contract for callback registration, callback payload, callback authentication/acknowledgment, Pull registration/query methods and payloads, pagination and response schema | Prevents invented endpoints, fields, signatures, or success semantics | No provider adapter implementation beyond contract-independent interfaces/fixtures. |
| G5-B03 | Exact merchant enablement for both callback and Pull Transactions on the real Buy Goods Till, including any Safaricom onboarding or production approval | A generic API guide does not prove a merchant can use the capability | Profile remains not operational. |
| G5-B04 | Timestamp semantics and tolerance, established with actual SMS and Daraja fixtures | Prevents false matches and false rejections | Timestamp conflict or unsupported precision goes to review; no arbitrary tolerance. |
| G5-B05 | Raw SMS and payer PII retention period, authorized visibility, dispute hold and deletion policy | Personal financial data requires a deliberate retention decision | Store only what is necessary, encrypted; do not enable production until the owner-approved policy is documented. |
| G5-B06 | G3 implementation of Tenant-level carried-forward credit for multi-unit combined accounts | Product rule is fixed: excess remains the Tenant's money and reduces future combined rent due within the same client/Estate. Current G3 does not pool credit across Tenancies. | Keep excess in an auditable G3 Tenant-account credit mechanism; never drop it, refund it automatically, or pin it to an arbitrary House. |
| G5-B07 | Criteria and evidence source for verifying historical ledger coverage before a closed link becomes SETTLED | Current summaries may expose `historicalCoverage: 'UNVERIFIED'` | Keep link `ARREARS_ONLY`/review; never auto-close from a zero projection. |
| G5-B08 | Celcom `unknown` send outcome recovery, including whether delivery status can be queried or manually confirmed | Blind retry can send a compromised/reused permanent link multiple times | Keep encrypted payload quarantined and require controlled operator resolution; no blind resend. |
| G5-B09 | Daraja application credential ownership: Tycoon app-level consumer credentials versus any merchant-specific credentials/authorization | Prevents incorrect cross-client secret scoping | Do not choose a per-merchant or shared credential model until portal onboarding confirms it. |
| G5-B10 | Admin-only resolution policy where the SMS evidence is missing, malformed, or disputes another tenancy | Prevents silent bypass of the evidence rule or dual-control expectations | Automatic posting still requires both SMS and Daraja evidence; no undocumented override. |

## 11. Release gates

G5 must pass these gates in order:

- **G5.0 — Design/source audit:** PRD, architecture, summary, and guardrails agree. No G5 code or migrations.
- **G5.1 — Schema/index design:** new domain schemas and uniqueness constraints reviewed; migration preflight and readiness checks designed. No financial posting yet.
- **G5.2 — Tenancy link and protected notification lifecycle:** review and approve the lifecycle/outbox design, resolve required owner decisions, then implement only under explicit authorization. Tenant/Tenancy/link/outbox/audit atomicity, protected payload handling, dispatch fencing, seed suppression and real Mongo integration tests must pass before enabling G5 provisioning.
- **G5.3 — SMS submission and deterministic parser:** parser fixtures, idempotency, privacy, and abuse controls pass.
- **G5.4 — Daraja callback contract:** exact authenticated sandbox contract and merchant identity mapping are proven; durable ingress and quarantine tested.
- **G5.5 — Pull recovery:** verified registration/query contract, bounded windows, pagination and checkpoints proven.
- **G5.6 — Evidence verification and claims:** callback/pull/SMS arrival permutations and claim concurrency pass.
- **G5.7 — G3 MPESA posting:** Payment, allocations, ledger, overpayment, closed-tenancy and retry semantics pass real transaction tests.
- **G5.8 — Controlled operational release:** sandbox/live evidence, monitoring, provider readiness, privacy policy, runbooks, rollback and release approval complete.

## 12. G5.0 scope and non-claims

G5.0 is documentation and source-audit work only. It does not create models, routes, migrations, workers, Daraja credentials, SMS behaviour, accounting code, or production configuration. No G5 tests have been run because G5 code does not exist. Existing repository test counts reported elsewhere are historical G3/G4 evidence and must not be presented as G5 test results.


## 13. G5.0.2 follow-up source review (12 November 2026)

This documentation-only addendum records a second source review against `main` at `204c8f9c3578f753af20727799aaa049b1545135`. The G5 documentation branch was at `addd0b39e7c5357c1b7f397ba82b53997ec14e67` before this amendment. No application code, database, migration, provider account, or test environment was changed or exercised.

### Clarification to G5-B06 — G3 credit is partly represented already

The current G3 source does not leave all overpayment behaviour undefined:

- `rentService.outstandingChargesForTenancy()` selects only rows for the exact tenancy and statuses `UNPAID`, `PARTIAL`, and `OVERPAID`.
- `planAllocation()` can allocate excess into the final target charge, after which the charge projection can become `OVERPAID`.
- When there are no eligible outstanding charge rows, the allocation plan is empty. The shared posting path still writes the full confirmed amount to the Payment and tenancy-scoped Ledger PAYMENT entry; the returned result exposes the unallocated remainder as `unappliedCents`.
- `ledgerService.balanceForTenancy()` exposes positive `knownCreditCents` from that exact tenancy's Ledger sum. The house projection groups by tenancy and totals positive credits separately from arrears; it does not net one tenancy's credit against another tenancy's debt.
- Existing G3 tests cover an OVERPAID charge or an unapplied remainder and recognize a legitimate unapplied Payment remainder as informational rather than corruption.

This proves an existing accounting representation, not a complete approved credit policy. There is no approved G5 right to refund, spend, transfer, or silently consume an old-tenancy credit. B06 remains open for owner approval of the operational treatment and reconciliation of credit, with automatic posting still gated on closed-tenancy integration tests proving the complete receipt remains accounted for and never benefits a later tenancy.

### Clarification to G5-B07 — current helper cannot prove historical completeness

The current `ledgerService.balanceForTenancy()` returns `historicalCoverage: 'UNVERIFIED'` and `verifiedFullObligation: false`. The same provisional status is returned by the house-level projection. A zero known balance therefore does not satisfy the G5 `SETTLED` condition. No current helper inspected in this review supplies the missing verified-coverage result. B07 remains open; G5 must keep a closed link non-terminal until an auditable coverage mechanism or owner-approved attestation is defined.

### New technical implementation gates

| ID | Evidence-backed constraint | Required design response |
|---|---|---|
| G5-D13 | The normal `/api/v1` router is mounted behind `csrfProtection`; only auth signup/login are exempt. The current global JSON parser runs before route mounting and applies a 1 MB cap. The current Redis rate-limit store deliberately fails open on Redis errors. | The public bearer submission endpoint must be a narrow, separately mounted route before the authenticated CSRF boundary, must not depend on a cookie session, and must have an explicit bounded body parser that runs before the global parser (or a reviewed parser-order change). Do not rely only on the fail-open Redis limiter; specify fail-closed or independent upstream abuse protection. Do not put the public submission endpoint in the provider-webhook namespace. |
| G5-D14 | The existing SMS queue is drained by `smsReminderJob()`, which the API-process scheduler runs every 15 minutes. `_claimNextBatch()` marks records `processing` but does not reclaim stale work. Celcom `unknown` is retained as `unknown`, not safely retried. | Reuse the existing queue/provider. Add a fenced dispatch lease and durable `sendStartedAt` boundary: reclaim only expired pre-send work; treat expired/in-flight post-start work as `unknown`. The 15-minute cadence is not an approved onboarding SLA; owner must set maximum time-to-first-attempt. Do not create a second queue or worker platform. |
| G5-D15 | `tenantService.create()` and `tenancyService.moveToHouse()` have transactions, but `tenantService.update(status='moved_out')` updates Tenant before closing Tenancy separately. `seedDemoClient.js` also calls `tenancyService.open()` directly. It additionally inserts sample SMS history with `status: 'queued'` despite a “not sent” comment; the normal scheduler drains queued rows. | Centralize moved-out into one transaction before G5 lifecycle hooks. Refactor move to accept a caller-owned session. Require an explicit G5 `DISABLED`/`REQUIRED` provisioning decision. Seed must not opt into G5 and every demo SMS row must be explicitly suppressed and excluded by the live claim predicate. |
| G5-D16 | MongoDB `withTransaction()` callback API retries the whole transaction on transient transaction errors and retries commit on unknown commit results. | Preallocate stable Tenant/Tenancy/link/outbox IDs, token/version and idempotency key; pin the outbox key version. Generate a fresh GCM nonce/envelope inside each callback attempt after session-bound merchant validation. No Celcom/provider call or other non-idempotent external side effect may occur inside the callback. Resolve uncertain commit outcomes before any dispatch. |
| G5-D17 | Protected outbound recipient/body is encrypted while queued; the retention period after provider acceptance and for unknown outcomes is not yet approved. | Define clearing/hold policy for encrypted recipient/body. Do not invent a TTL or retain permanent bearer URLs indefinitely without an approved purpose/period. |
| G5-D18 | Current move/move-out writes can act on a later occupant if they do not compare the exact source Tenancy and House pointer. `tenantService.get()` exposes neither all active Tenancies nor their IDs. | Expose `activeTenancies[]` with exact per-unit IDs and balances. Require `expectedTenancyId` for the specific unit being moved/closed; compare the selected Tenancy and House pointer in the same transaction. Other active Tenancies for the Tenant must remain untouched. |

| G5-D19 | Authenticated owner/admin PATCH /houses/:id accepts status occupied/vacant and isActive; houseService.update() persists these without checking House.tenantId or an ACTIVE Tenancy. paymentService.recordManual() uses House status to decide whether to create House charges. Generic PATCH /tenants/:id also accepts status active, which tenantService.update() writes without opening a new Tenancy. | Make House occupancy status lifecycle-owned: remove status from generic House PATCH/service allowlist, and reject deactivation while a pointer or ACTIVE Tenancy exists. Do not permit generic Tenant reactivation; any approved reactivation must create a new Tenancy and update House/Tenant atomically. |
| G5-D20 | tenancyService.open() can accept a stale same-Tenant House pointer, does not require an active House, does not validate exact Tenant/House/Estate ownership inside the session, ignores the Tenant update matched count, and accepts caller Estate mismatch. | Harden open() with exact session-bound ownership, active target House and null target House pointer; verify update matched count. Permit other active Tenancies for the Tenant in different Houses within the same Estate. Keep only per-House ACTIVE uniqueness. |

The public landing-page implementation/hosting owner is also not identified in the backend repository. Before G5.3, record whether the page belongs to a separate frontend repository or a separately deployed static application, and identify its owner. The browser requirements remain: fragment-only initial token transport, immediate fragment removal, no third-party analytics, no persistent browser storage, no-referrer, no-store, and restrictive CSP.

These D-items are engineering/design gates, not replacements for owner decisions G5-B01 through G5-B10. No provider contract or business policy has been inferred from them.


## 14. G5.1 schema/index design decision

The schema and index proposal is maintained in [G5_1_SCHEMA_INDEX_DESIGN.md](G5_1_SCHEMA_INDEX_DESIGN.md). It is documentation-only and does not authorize model or migration implementation.

The proposal deliberately starts with five core records and stores the one-winning claim/processing lease on the canonical transaction rather than creating a separate claim collection. The claim design is valid only after canonical provider-receipt identity is uniquely enforced. B01/B02 still block final merchant and receipt uniqueness keys; MPESA financial posting therefore remains disabled until the exact unique index is installed and verified. B09 blocks credential ownership; B05 blocks retention/TTL decisions. No operational feature may bypass these unresolved gates.

## 15. G5.2 tenancy-link and protected-outbox design

The lifecycle and protected notification decision record is [G5_2_TENANCY_LINK_AND_OUTBOX_DESIGN.md](G5_2_TENANCY_LINK_AND_OUTBOX_DESIGN.md). It is documentation-only and does not authorize implementation.

The current proposal uses trusted `DISABLED`/`REQUIRED` provisioning modes. When required, Tenant, Tenancy, link, protected `SmsMessage` outbox item and critical audit row commit in one Mongo transaction; when disabled, normal G3 lifecycle continues without G5 records. Required provisioning fails the full operation if merchant mapping, capability or encryption readiness is missing.

The existing SMS queue/provider remains the only dispatch path. Protected message content and destination are encrypted in a versioned G5 envelope with AAD, while ordinary SMS fields/history contain only redacted values. Dispatch leases are fenced; expiry before `sendStartedAt` may be safely reclaimed after link validation, while expiry after `sendStartedAt` is `unknown` and never blindly resent. Demo seed records must be suppressed, not queued.

**G5.2 independent review verdict:** APPROVE WITH REQUIRED CHANGES; the resolution is recorded in §16 and G5_2_TENANCY_LINK_AND_OUTBOX_DESIGN.md §16. **Implementation remains NO-GO** for lifecycle refactors, SmsMessage schema changes, encryption key creation, dispatch worker changes, migrations or Celcom sends until separate explicit bounded owner authorization. B01/B03, B05, B08, D11, D14 and D17 remain relevant gates.

## 16. G5.2 independent review resolution (12 November 2026)

The independent G5.2 review returned **APPROVE WITH REQUIRED CHANGES**. The normative corrections are recorded in G5_2_TENANCY_LINK_AND_OUTBOX_DESIGN.md §16 and are mandatory acceptance requirements:

- Move/move-out require the exact expected ACTIVE Tenancy ID. Missing/stale IDs fail closed. Old-House pointer release and tenancyService.close() require exact tenant match and matchedCount === 1. Any non-null destination House pointer is a conflict and is not silently repaired.
- Move-out is one transaction. A replay against the exact already-CLOSED MOVE_OUT Tenancy is a no-op and cannot mutate a later occupant.
- Authenticated Tenant detail returns `activeTenancies[]` after exact Tenant/Tenancy/House pointer checks. Controllers pass the exact `expectedTenancyId` and actor identity into unit-specific lifecycle operations.
- Extend strict SmsMessage enums with g5_onboarding_link, cancelled and suppressed before use. Seed/test rows use status suppressed and dispatchMode SUPPRESSED; provider mock must record zero calls.
- Standard claim positively allows only deliveryMode absent or exactly STANDARD and dispatchMode absent or exactly SEND; explicit null/malformed values are excluded. Protected claim requires exact G5_PROTECTED plus SEND and never falls back to plaintext. Expired pre-send leases may requeue only after link/version validation; expired post-send-start leases become unknown and are never automatically requeued.
- submissionRevision, dispatchRevision, tokenVersion and notificationVersion are distinct. The observed dispatchRevision is part of the link CAS paired with the SMS send-start write.
- Live smsmessages.idempotencyKey index presence and duplicate state are unverified. Inspect the actual DB index; Mongoose unique:true is not proof.
- The in-flight-after-rotation message race is unavoidable after send-start; D11 must capture owner acceptance and support handling. D14 dispatch SLA, B08 unknown-send resolution and D17 encrypted outbound retention remain open.
- B09 concerns Daraja API credential scope. It does not block non-secret Till instructions once B01/B03 establish the actual destination. No provider/API credential may be included in an SMS.

The review did not establish live database index state, merchant mapping/capability, Celcom status lookup, retention policy or owner risk acceptance. Those remain release gates. **G5.2 implementation remains NO-GO** until separate bounded owner authorization and relevant gates are satisfied.

## 17. G5.2.2 full lifecycle call-site audit resolution (12 November 2026)

The pinned main@204c8f9c3578f753af20727799aaa049b1545135 repository tree was fetched recursively with 282 entries and truncated=false. All 157 src/ JavaScript files, 21 scripts/ JavaScript files and 57 JavaScript tests were fetched by blob SHA; no retrieval/decode errors occurred. Raw collection and generic bulk-write scans found no hidden production Tenant/Tenancy/House occupancy writer.

The production Tenancy occupancy writers are tenancyService.open(), close() and moveToHouse(). Other production Tenancy.updateOne() calls in accountingPosting, ledger and reconciliation only increment ledgerRev as financial write fences. The demo seeder is the only separate script caller of low-level tenancyService.open() found.

The audit found two additional API mutation paths and an under-validated open primitive:
- Generic House PATCH changes occupancy status and isActive without checking a live Tenancy/pointer. House.status affects manual-payment charge generation. Make occupancy status lifecycle-owned and block deactivation of occupied Houses.
- Generic Tenant PATCH can set status active without opening a Tenancy. Remove generic reactivation; any future reactivation requires a dedicated atomic lifecycle operation.
- tenancyService.open() permits a stale same-Tenant House pointer, accepts inactive Houses, lacks exact in-session Tenant ownership, ignores the Tenant update matched count, trusts caller Estate ID and does not prevent multiple ACTIVE Tenancies for one Tenant. Harden before G5 hooks.
- The existing Tenancy unique partial index is per House only. A proposed per-Tenant partial unique index is recorded in G5_1_SCHEMA_INDEX_DESIGN.md §12, subject to owner confirmation and duplicate preflight.

The detailed source paths, required corrections and test gaps are in G5_2_TENANCY_LINK_AND_OUTBOX_DESIGN.md §17. G5.2 remains **NO-GO for implementation**. No application code, database, migration, provider, key or test environment was changed.


## 16. Owner-confirmed Tenant-level M-PESA account rules (12 November 2026)

### Multiple rental units
- One Tenant profile may own multiple simultaneous active Tenancies in different Houses within the same Estate. A Tenant with one active unit uses the single-account experience; only a Tenant with multiple active units sees a combined statement.
- One private submission link identifies `{ clientId, estateId, tenantId }`. The tenant or a third-party payer submits one complete confirmation SMS. The same existing SMS provider and sender configuration are used; sender ID is not a G5 design variable.
- One M-PESA receipt is verified and claimed once for the Tenant. The G3 accounting operation may create one Payment per affected Tenancy, with every Payment and allocation remaining Tenancy-scoped.
- The sum of all tenancy Payment portions plus any Tenant-account credit movement must equal the verified Till receipt amount exactly. All postings and the receipt's POSTED state are atomic.

### Underpayment and overpayment
- The combined statement is the sum of the Tenant's eligible obligations across their Tenancies in the same Estate.
- Apply a partial payment deterministically to the oldest eligible due obligation first, with stable tie-breakers. The payer does not choose or type a per-House split.
- If the receipt exceeds all currently eligible obligations, the excess remains the Tenant's carried-forward rent credit and reduces the next combined rent due. Credit is not lost, refunded automatically, or assigned to another Tenant.
- For multi-unit Tenants, credit must be held and applied in G3 under the Tenant/client/Estate account scope. Current G3 keeps tenancy credits separate, so this requires a G3 aggregate-credit extension. It must not be implemented as a G5 wallet or a silent cross-Tenancy Ledger transfer.

### Client-configured rent changes
- G5 does not decide the effective date or proration when a Tenant moves to a different unit or rent changes.
- The applicable Client configuration defines the effective-date and proration policy. G3 generates the resulting RentCharges from that configuration; G5 allocates verified receipts only to the resulting eligible obligations.
- Persist the effective policy/version and resulting charge snapshots. A missing or invalid client policy must not be replaced by a hard-coded G5 default.

### Tenant/Tenancy lifecycle
- Tenant detail returns `activeTenancies[]`; each entry contains exact `tenancyId`, `houseId`, `estateId` and tenancy-scoped financial context.
- `Tenant.houseId` is not the source of truth for occupancy or payment attribution. Tenancy records and House ownership checks are authoritative. Tenant-wide status reflects whether any active Tenancy remains; per-occupancy dates belong to Tenancy history.
- Add/move/close operations identify one exact `expectedTenancyId`. Closing or moving one unit must not alter the Tenant's other active Tenancies.


## 17. Owner decision resolutions — Tenant accounts, credit and rent configuration

- **D21 — multi-unit Tenant:** RESOLVED at product level. One Tenant profile can have multiple active Tenancies in different Houses within the same Estate. The G5 link is Tenant-level. The API exposes `activeTenancies[]`; `Tenant.houseId` is not authoritative. Remaining work is a compatibility-safe G3 implementation contract, not a request to choose one active tenancy.
- **D22 — combined payment and excess credit:** RESOLVED at product level. One receipt is claimed once; partial payment reduces the combined balance; any amount above current eligible obligations remains the Tenant's carried-forward credit and reduces the next combined rent due within that same Estate. G3 must implement this auditable Tenant-account credit; the existing Tenancy-only balance service is not sufficient.
- **D23 — rent effective date/proration:** RESOLVED as a configuration rule. Each Client's configured policy decides the effective date and proration when the Tenant moves to a different unit or rent changes. G3 billing generates the applicable RentCharges; G5 consumes them and does not hard-code dates or proration.
- **Remaining technical gates:** G3 tenant-account credit/application design and atomic posting; Payment receipt index migration for one child Payment per Tenancy; Tenant profile compatibility fields and aggregate DTO; Daraja merchant/receipt uniqueness and actual Till callback/Pull capability. These are implementation design/evidence gates, not unresolved product intent.


## 22. Implementation status addendum — Tenant M-PESA collection (feature/g5-construction)

Authoritative design record: [G5_COLLECTION_IMPLEMENTATION_DESIGN.md](G5_COLLECTION_IMPLEMENTATION_DESIGN.md). Resolutions D21–D23 are implemented as follows (code may exist; this is NOT production readiness):

- D22 Tenant credit: immutable `TenantCreditMovement` ledger, derived balance, `Tenant.creditRev` serialization; credit applied automatically, oldest obligation first.
- Multi-Tenancy posting: one claimed receipt produces one child Payment per Tenancy portion (`origin: MPESA`, `mpesaReceiptId` = internal `MpesaTransaction._id`) in one MongoDB transaction; requires the migration-controlled compound Payment index.
- Gates B01–B05, B07–B10 remain unresolved. Posting is disabled by default and additionally blocked while canonical receipt identity (B01/B02) is not proven. No retention/TTL for submitted SMS is invented (B05): raw text is not retained until a policy exists. SMS template wording is verified only against synthetic fixtures (B04).
- Integration tests requiring a MongoDB replica set are written but only count as evidence when actually executed.
