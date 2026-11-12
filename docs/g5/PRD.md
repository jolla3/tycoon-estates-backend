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

G5 enables a Tycoon Estates client to accept ordinary customer-to-merchant M-PESA Buy Goods / Till payments for rent and correctly attribute each receipt to the intended tenancy.

A Buy Goods customer payment does not provide the dependable tenancy/account reference that is available in many PayBill workflows. The Till receives the money, but a receipt alone does not identify the tenant's house or tenancy. G5 solves the attribution problem without changing the client's collection channel:

1. When a tenancy is created, Tycoon creates a private submission link bound to that exact immutable `Tenancy` record.
2. Tycoon sends the tenant the merchant's Till instructions and the private link through the existing SMS delivery infrastructure.
3. The tenant or another person paying on the tenant's behalf makes an ordinary Buy Goods payment.
4. The tenant or payer submits the complete M-PESA confirmation SMS using the tenancy link.
5. Tycoon parses that SMS as untrusted evidence and independently verifies it against the merchant's Daraja C2B transaction data.
6. A verified receipt is claimed once and posted through the existing G3 accounting service.

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
- Bind every submission link to one exact historical `Tenancy._id`.
- Permit third-party payment without requiring payer MSISDN equality with the tenant's registered phone.
- Parse the customer's M-PESA confirmation SMS deterministically.
- Independently confirm receipt against actual Daraja C2B records.
- Converge callback and Pull Transactions ingestion on one canonical transaction identity.
- Ensure one external receipt can result in at most one successful G3 Payment.
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
4. In the same MongoDB transaction, G5 creates a private link bound to that exact Tenancy and a durable protected notification-outbox item.
5. After commit, the existing SMS worker sends the Till instructions and link through the existing provider abstraction.
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

### FR-02 — Tenancy-specific private link

- Generate at least 256 bits of cryptographically secure randomness.
- Persist only a one-way token hash or keyed lookup digest in `MpesaSubmissionLink`.
- Bind the link to the exact `clientId`, `estateId`, `houseId`, `tenantId`, and immutable `tenancyId` captured at creation.
- Never resolve an old link through mutable `Tenant.houseId`, `Tenant.status`, `House.tenantId`, or a current-occupant query.
- The link association remains with its original tenancy. A move creates a new link for the new Tenancy; it does not reassign the old link.
- The association may be long-lived while that tenancy's obligations are unresolved. The secret itself must be revocable/rotatable after compromise without changing historical tenancy identity.
- The token is a bearer credential for tenancy association, not proof of the submitter's human identity.
- Invalid token responses must not disclose tenant, house, balance, estate, or link-existence information.

### FR-03 — SMS onboarding and secret handling

- Create the protected outbound notification item atomically with the tenancy/link transaction.
- Do not call Celcom or any external SMS provider while the MongoDB transaction is open.
- Reuse the existing SMS provider/worker boundary. Do not create a parallel SMS platform.
- The bearer URL must not be stored in ordinary plaintext `SmsMessage.message`, tenant details, SMS history, audit metadata, structured logs, error telemetry, or provider response logs.
- If the existing SMS record is extended, use authenticated encryption for the token-bearing body, key versioning, authenticated associated data, tightly limited decryption, and API/history redaction. A separate outbox is allowed only if it remains integrated with the existing delivery worker and does not create a second queue system.
- Do not blindly retry a provider outcome of `unknown`; the first send may have succeeded. Define a safe operator recovery path before production.

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
- Canonical transaction belongs to the merchant profile resolved for the tenancy link.
- Merchant identity dimensions returned by Safaricom match the configured profile and allowed estate/store mapping.
- Transaction is a customer-to-merchant credit supported by the verified payload schema, not a debit, reversal, B2B, or unrelated movement.
- Timestamp falls within a tolerance established using actual sandbox fixtures and documented provider semantics. No arbitrary tolerance may be invented.
- Link snapshot still matches the historical Tenancy's immutable ownership fields.
- No other link/claim has already successfully claimed or posted the same canonical receipt.

Payer MSISDN equality is deliberately not a requirement. Any material conflict or unknown field needed to establish merchant or transaction identity moves the claim to review.

### FR-08 — G3 payment posting

- Use `Payment.origin = 'MPESA'`.
- `Payment.mpesaReceiptId` is an ObjectId reference to the internal canonical `MpesaTransaction._id`. It is never the external alphanumeric receipt string.
- Extend the shared `accountingPosting.service.js` path. Do not call the staff-only MANUAL path and do not implement a parallel ledger.
- Persist the external receipt number in an appropriate display/reference field only after confirming the existing G3 field semantics and validation limits.
- Idempotency is based on the canonical internal transaction identity and is protected by MongoDB uniqueness plus transactional checks.
- A retry that finds an existing Payment must validate its full merchant transaction, tenant, house, estate, tenancy, amount, date, origin, and allocation scope before reporting success.
- Payment, allocation rows, charge projections, Ledger PAYMENT, and claim/transaction POSTED state must commit or roll back together in one MongoDB transaction.
- Existing BANK and MANUAL posting callers and behavior must remain unchanged.

### FR-09 — Closed-tenancy arrears

A verified late payment may settle only existing obligations of the exact historical tenancy identified by the submission link.

- The `tenancyId` on the original link is the historical attribution key, even when payment time is after `Tenancy.endAt`.
- Only pre-existing outstanding `RentCharge` records belonging to that exact `tenancyId`, client, estate, and house may receive allocations.
- Do not create new rent charges or new billing periods for a closed tenancy as a side effect of receipt posting.
- Do not invoke G4's date-based `tenancyContains(paymentDate)` rule for this link-bound arrears case. Do not change that shared rule or G4 bank reconciliation.
- Any unapplied amount must remain an old-tenancy credit and must never reduce a later tenancy's balance.
- The exact G3 representation of unapplied credit and the atomic posting behaviour must be verified in source and tests before enabling automatic overpayment posting. If G3 cannot represent the full receipt and its unapplied remainder safely, route the receipt to controlled review; do not discard the remainder or invent a new ledger path.
- Do not automatically refund, transfer, or spend overpayment credit in G5.
- A closed link may become `SETTLED` only when G3 historical financial coverage is verified, all eligible obligations are resolved, no unapplied credit remains unresolved, and no pending/conflicting claims remain. If coverage is `UNVERIFIED`, keep the link non-terminal and require an authorized review. Never infer settlement from a zero cached projection alone.

### FR-10 — Manual review and audit

- Review endpoints are authenticated, role-authorized, and scoped by the existing client/estate context.
- Reviewers can inspect mismatches, unknown merchant identities, duplicate claims, unsupported SMS, delayed/missing provider records, and historical ledger uncertainty.
- A manual association/override requires explicit permission, a recorded reason, an immutable before/after audit trail, and a second approval where the eventual financial-risk policy requires it.
- Manual review must still use the canonical M-PESA transaction and shared G3 posting path.
- Phase one must not silently bypass the two-evidence rule (submitted SMS plus merchant-side Daraja record). Any proposed admin-only exception for a receipt without SMS is a separate product/security decision and must be explicitly approved before implementation.
- A reviewer cannot associate a receipt already posted to another tenancy with a second Payment.

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
3. A tenant move creates a separate new link; the old link remains permanently bound to its original Tenancy.
4. A revoked/rotated token cannot be used, and token-bearing content is absent from ordinary database/API/history/log surfaces.
5. A third-party payer can submit the receipt without matching the tenant phone number.
6. A fabricated or edited SMS with no matching Daraja record cannot create a Payment.
7. Callback and Pull copies of the same receipt converge to one canonical `MpesaTransaction` only after B01/B02 establish the provider receipt identity scope and its unique index is installed and runtime-verified; before that, ambiguous/duplicate candidates remain quarantined and non-postable.
8. A transaction arriving before the SMS and an SMS arriving before the transaction both converge safely.
9. A receipt submitted through two tenancy links cannot silently switch or post twice.
10. Concurrent submissions, callbacks, pulls, worker retries, and claim lease takeover produce at most one Payment and one Ledger PAYMENT movement, including when duplicate provider events could otherwise create more than one internal transaction candidate.
11. Payment/allocation/charge/Ledger/claim state is atomic under injected failures.
12. BANK and MANUAL G3 regression suites pass unchanged.
13. A closed-tenancy late payment allocates only to existing old-tenancy charges, creates no new charges, and does not reduce the new tenancy balance.
14. An overpayment is retained as credit on the old tenancy or sent to controlled review if G3 cannot safely represent it; no credit is lost or transferred.
15. The old link is not marked SETTLED while historical ledger coverage is unverified or claims/credit remain unresolved.
16. Exact Daraja callback, registration, pull, pagination, acknowledgement, merchant-identity, and timestamp behaviour is demonstrated using the actual authenticated portal and controlled sandbox fixtures.
17. Live merchant readiness is confirmed for the actual Till/Store/Head Office configuration. Public documentation alone is insufficient.
18. All financial tests use a dedicated disposable `tycoon_test_*` MongoDB replica-set/sharded test database and the repository's explicit destructive-test safeguards.
19. Existing G3 and G4 regression suites pass.
20. MPESA posting is fail-closed if the canonical `{ merchantProfileId, receiptNumber }` uniqueness scope is unresolved, if duplicate candidates exist, or if the exact live unique index/readiness check is missing or misaligned. The existing `Payment.mpesaReceiptId` index alone is not accepted as proof of external-receipt uniqueness.

## 10. Blocking decisions and provider evidence required

The following must be resolved before the relevant implementation slice is allowed to proceed. They must not be filled in by an agent's best guess.

| ID | Decision / evidence | Why it blocks | Safe default while unresolved |
|---|---|---|---|
| G5-B01 | Actual merchant hierarchy: whether this Till maps to one estate, several estates, or multiple Store identities; exact shortcode/Till/Store/Head Office/Notification/Nominated semantics | Determines transaction ownership and whether a Till receipt can map to the correct profile/store | Disable automatic posting for ambiguous merchant scope. |
| G5-B02 | Authenticated Daraja sandbox contract for callback registration, callback payload, callback authentication/acknowledgment, Pull registration/query methods and payloads, pagination and response schema | Prevents invented endpoints, fields, signatures, or success semantics | No provider adapter implementation beyond contract-independent interfaces/fixtures. |
| G5-B03 | Exact merchant enablement for both callback and Pull Transactions on the real Buy Goods Till, including any Safaricom onboarding or production approval | A generic API guide does not prove a merchant can use the capability | Profile remains not operational. |
| G5-B04 | Timestamp semantics and tolerance, established with actual SMS and Daraja fixtures | Prevents false matches and false rejections | Timestamp conflict or unsupported precision goes to review; no arbitrary tolerance. |
| G5-B05 | Raw SMS and payer PII retention period, authorized visibility, dispute hold and deletion policy | Personal financial data requires a deliberate retention decision | Store only what is necessary, encrypted; do not enable production until the owner-approved policy is documented. |
| G5-B06 | G3 representation and reconciliation of unapplied payment credit/overpayment, including how exact historic obligations are determined | Prevents money from being lost, misallocated, or moved across tenancies | Do not auto-post an overpayment until G3 semantics are proven; review it. |
| G5-B07 | Criteria and evidence source for verifying historical ledger coverage before a closed link becomes SETTLED | Current summaries may expose `historicalCoverage: 'UNVERIFIED'` | Keep link `ARREARS_ONLY`/review; never auto-close from a zero projection. |
| G5-B08 | Celcom `unknown` send outcome recovery, including whether delivery status can be queried or manually confirmed | Blind retry can send a compromised/reused permanent link multiple times | Keep encrypted payload quarantined and require controlled operator resolution; no blind resend. |
| G5-B09 | Daraja application credential ownership: Tycoon app-level consumer credentials versus any merchant-specific credentials/authorization | Prevents incorrect cross-client secret scoping | Do not choose a per-merchant or shared credential model until portal onboarding confirms it. |
| G5-B10 | Admin-only resolution policy where the SMS evidence is missing, malformed, or disputes another tenancy | Prevents silent bypass of the evidence rule or dual-control expectations | Automatic posting still requires both SMS and Daraja evidence; no undocumented override. |

## 11. Release gates

G5 must pass these gates in order:

- **G5.0 — Design/source audit:** PRD, architecture, summary, and guardrails agree. No G5 code or migrations.
- **G5.1 — Schema/index design:** new domain schemas and uniqueness constraints reviewed; migration preflight and readiness checks designed. No financial posting yet.
- **G5.2 — Tenancy link and protected notification lifecycle:** create/move/close lifecycle atomicity and secret handling pass real Mongo integration tests.
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
| G5-D14 | The existing SMS queue is drained by `smsReminderJob()`, which the API-process scheduler runs every 15 minutes. `_claimNextBatch()` marks records `processing` but does not reclaim an expired/stale processing record. Celcom `unknown` is retained as `unknown`, not safely retried. | Reuse the existing queue/provider, but design a durable dispatch-attempt/lease recovery rule. A crash-stuck job must be recoverable without blindly resending a message that may already have reached Celcom. Define the acceptable onboarding-SMS latency; do not describe the current arrangement as a separate worker process. |
| G5-D15 | `tenantService.create()` and `tenancyService.moveToHouse()` use transaction boundaries, but `tenantService.update(status='moved_out')` updates Tenant first and closes Tenancy in a separate operation. The demo seed script also opens Tenancy directly. | Centralize the moved-out operation in one transaction before linking lifecycle state. Explicitly exclude non-operational demo/seed data from real SMS delivery, or provide a clearly isolated seed policy. |

The public landing-page implementation/hosting owner is also not identified in the backend repository. Before G5.3, record whether the page belongs to a separate frontend repository or a separately deployed static application, and identify its owner. The browser requirements remain: fragment-only initial token transport, immediate fragment removal, no third-party analytics, no persistent browser storage, no-referrer, no-store, and restrictive CSP.

These D-items are engineering/design gates, not replacements for owner decisions G5-B01 through G5-B10. No provider contract or business policy has been inferred from them.


## 14. G5.1 schema/index design decision

The schema and index proposal is maintained in [G5_1_SCHEMA_INDEX_DESIGN.md](G5_1_SCHEMA_INDEX_DESIGN.md). It is documentation-only and does not authorize model or migration implementation.

The proposal deliberately starts with five core records and stores the one-winning claim/processing lease on the canonical transaction rather than creating a separate claim collection. The claim design is valid only after canonical provider-receipt identity is uniquely enforced. B01/B02 still block final merchant and receipt uniqueness keys; MPESA financial posting therefore remains disabled until the exact unique index is installed and verified. B09 blocks credential ownership; B05 blocks retention/TTL decisions. No operational feature may bypass these unresolved gates.
