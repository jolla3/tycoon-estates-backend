# G5.0.1 — Workspace Integrity and Decision Audit

**Date:** 12 November 2026  
**Repository:** `jolla3/tycoon-estates-backend`  
**Workspace at audit time:** `/home/workdir/artifacts/G5`  
**Pinned source baseline:** `204c8f9c3578f753af20727799aaa049b1545135` (`main`)  
**Scope:** Workspace integrity, owner-decision extraction, blocker classification and architecture challenge.

> **Publication provenance:** This is a normalized transcription of the G5.0.1 findings supplied by the project owner in this conversation. It is not a byte-identical export of the original report generated inside Grok's hosted workspace. The original report file was not available to this ChatGPT session.

## 1. Executive result

The audit found an incomplete application-tree copy. Five baseline controllers were missing at the start of the audit. They were restored byte-identically from commit `204c8f9c3578f753af20727799aaa049b1545135`. After restoration, the checked application tree had zero missing files, zero extra files and zero content differences.

No G5 product code was implemented. No models, routes, migrations, jobs, Daraja clients, SMS changes or accounting changes were introduced. The only application-tree changes during the audit were restoration of the five missing baseline controllers.

The audit recommended G5.1 schema/index design as the next possible slice, subject to explicit owner authorization. It did not authorize implementation.

## 2. Workspace integrity

### 2.1 Initial Git state

At audit time, `/home/workdir/artifacts/G5` was a plain directory copy and not a Git working tree:
- No `.git` directory.
- No in-tree Git repository root, branch, HEAD, remote or Git working-tree status.
- Source provenance was recorded in `G5_SOURCE_HEAD.txt`.
- File-level comparison was performed against a fresh checkout of the pinned commit.

The workspace was attached to `feature/g5-construction` in a later operation. That subsequent Git attachment does not change the historical audit-time observation.

### 2.2 Application-tree comparison

Compared application paths:
- `src/`
- `tests/`
- `scripts/`
- `package.json`
- `package-lock.json`
- `.gitignore`

| Metric | At audit start | After restoration |
|---|---:|---:|
| Baseline file count | 240 | 240 |
| G5 application file count | 235 | 240 |
| Missing files | 5 | 0 |
| Extra files | 0 | 0 |
| Content mismatches on common paths | 0 | 0 |

The five missing files restored byte-identically from commit `204c8f9c3578f753af20727799aaa049b1545135` were:
- `src/controllers/billing.controller.js`
- `src/controllers/connection.controller.js`
- `src/controllers/profile.controller.js`
- `src/controllers/sms.controller.js`
- `src/controllers/user.controller.js`

After restoration, the checked application tree matched the pinned baseline by path and content. G5 documentation was an intentional overlay and was not part of the baseline application-tree comparison.

## 3. Owner-decision register

G5-B01 through G5-B10 remain the authoritative unresolved decision set. The recommendations below are safe defaults, not owner approvals.

### G5-B01 — Merchant hierarchy and Till scope mapping

**Question:** Does this Till map to one estate, several estates, or multiple Store identities? What are the exact shortcode, Till, Store, Head Office, Notification and Nominated semantics for the client's Safaricom account?

**Options:** (a) one Till to one estate; (b) one Till to many estates through an explicit mapping table; (c) multi-store hierarchy requiring Store Number disambiguation.

**Recommendation:** Keep operational auto-post disabled until the actual merchant hierarchy and sample payloads prove the mapping. Schema may reserve neutral mapping fields, but ambiguous scope must remain non-operational.

**Decision owner:** Product owner and client operations, supported by Safaricom account evidence.  
**Evidence:** Actual merchant configuration and sample transaction payloads showing identity dimensions and estate/store mapping.  
**Blocks:** Automatic posting and operational merchant readiness; it does not block neutral schema design.  
**Classification:** Slice-specific; hard gate for auto-post.

### G5-B02 — Authenticated Daraja sandbox contract

**Question:** What are the exact callback registration, callback payload, authentication/acknowledgement, Pull registration/query methods, pagination rules and response schema for the enabled product?

**Options:** Implement only after official documentation and authenticated sandbox captures; or build contract-independent interfaces and fixtures first.

**Recommendation:** Keep interfaces contract-independent until official documentation and authenticated request/response fixtures exist. Do not invent endpoint paths, HTTP methods, signatures, acknowledgement bodies or payload fields.

**Decision owner:** Engineering verifies official Safaricom/Daraja materials; owner approves the verified-contract gate.  
**Evidence:** Official API documentation and authenticated sandbox fixtures for this app and merchant configuration.  
**Blocks:** G5.4 callback and G5.5 Pull adapters.  
**Classification:** Provider-verification blocker for those slices; not a blocker to G5.1–G5.3.

### G5-B03 — Merchant enablement for callback and Pull

**Question:** Is the actual Buy Goods Till enabled for both C2B callback and Pull Transactions, including any required Safaricom production approval?

**Options:** Callback-only, Pull-only, both, or neither.

**Recommendation:** Keep the merchant profile non-operational until required channels are proven for that merchant. Do not infer enablement from the existence of a developer portal app.

**Decision owner:** Client and Safaricom onboarding; owner records the enablement evidence.  
**Evidence:** Portal configuration, approval evidence and successful controlled sandbox events for the relevant merchant identity.  
**Blocks:** Operational release and production auto-post.  
**Classification:** Provider/release blocker; not a schema-design blocker.

### G5-B04 — Timestamp semantics and tolerance

**Question:** How do submitted SMS timestamps and Daraja timestamps align in timezone, precision and clock skew? What tolerance, if any, is justified?

**Options:** Exact match only; fixed tolerance; or field-specific rules derived from fixtures.

**Recommendation:** Do not choose an arbitrary tolerance. Conflicts go to review until paired fixtures establish a measured rule.

**Decision owner:** Engineering proposes from fixtures; owner approves any production tolerance.  
**Evidence:** Paired SMS and Daraja fixtures.  
**Blocks:** G5.6 evidence-matching strictness.  
**Classification:** Slice-specific; review-on-mismatch is a safe early default.

### G5-B05 — Raw SMS and payer PII retention

**Question:** What are the retention period, authorized visibility, dispute-hold and deletion rules for raw SMS and payer PII?

**Options:** Owner-defined retention duration, dispute-hold extension and role-based visibility.

**Recommendation:** Encrypt at rest, minimize retained fields and prohibit production use until a written policy exists. Do not invent retention days.

**Decision owner:** Data owner/product owner, with legal/privacy review as required.  
**Evidence:** Written policy covering retention, access, holds and deletion.  
**Blocks:** Production handling of live personal data, not non-production schema design for encrypted fields.  
**Classification:** Production release blocker; deferrable during design.

### G5-B06 — G3 unapplied credit and overpayment semantics

**Question:** How should overpayment/unapplied credit be represented and reconciled in G3 for M-PESA, especially across historical obligations and closed tenancies?

**Options:** Preserve existing Payment-level unapplied behavior; introduce an explicit credit ledger artefact only with a separately approved G3 change; or route unsupported remainders to review.

**Recommendation:** First prove existing BANK/MANUAL behavior in `accountingPosting.service.js` and its tests. Extend M-PESA to proven behavior. Do not invent credit movement or silently lose an amount.

**Decision owner:** Engineering if behavior is parity with existing G3 rules; product owner if financial rules change.  
**Evidence:** G3 OVERPAID/unapplied tests for BANK/MANUAL, followed by M-PESA parity and concurrency tests.  
**Blocks:** Automatic handling of remainders in G5.7.  
**Classification:** Slice-specific hard gate for automated overpayment handling.

### G5-B07 — Historical coverage before SETTLED

**Question:** What evidence proves historical ledger coverage sufficiently complete for a closed-tenancy link to become `SETTLED`?

**Options:** Authorized manual attestation; automated RentCharge/Payment/Ledger coverage scan; or never automatically SETTLED.

**Recommendation:** Keep the link in `ARREARS_ONLY` or review when historical coverage is `UNVERIFIED`. A zero projected balance alone is not proof of complete historical coverage.

**Decision owner:** Product owner defines coverage verification and who may attest.  
**Evidence:** Written definition of verified coverage and an auditable scan/attestation procedure.  
**Blocks:** SETTLED transition in close/move lifecycle and closed-tenancy close-out behavior.  
**Classification:** Slice-specific; resolve before automatic SETTLED transitions.

### G5-B08 — Celcom `unknown` send outcome recovery

**Question:** Can delivery status be queried when Celcom returns an unknown outcome, or must an operator resolve it manually?

**Options:** Provider status API; controlled operator confirmation; or quarantine without resend.

**Recommendation:** Do not blindly resend a permanent link. Keep the encrypted outbound payload quarantined and use controlled resolution until provider capabilities and operator procedure are proven.

**Decision owner:** Engineering verifies provider capabilities; owner approves operator SOP.  
**Evidence:** Celcom status-query capability and tested delivery outcomes.  
**Blocks:** Automated delivery recovery path only.  
**Classification:** Slice-specific; safe no-blind-resend default exists.

### G5-B09 — Daraja application credential ownership

**Question:** Are Daraja credentials Tycoon application-level consumer credentials, merchant-specific credentials, or a combination?

**Options:** Shared application-level credentials; per-client credentials; or per-merchant credentials.

**Recommendation:** Do not choose until portal onboarding confirms ownership and scope. Avoid cross-client secret-scope assumptions.

**Decision owner:** Owner and holder of the Safaricom developer account.  
**Evidence:** Safaricom portal app ownership and merchant onboarding model for this deployment.  
**Blocks:** Production credential-storage design and adapter authentication wiring.  
**Classification:** Provider/slice-specific; neutral placeholders may be designed without secrets.

### G5-B10 — Admin resolution without complete SMS evidence

**Question:** When SMS evidence is missing, malformed or conflicts with a tenancy, what admin-only resolution is permitted?

**Options:** No override; dual-control override; or single-admin override with full audit.

**Recommendation:** Automatic posting requires both SMS and Daraja evidence. No undocumented override; any exception requires explicit owner policy.

**Decision owner:** Product owner.  
**Evidence:** Written policy specifying roles, conditions, required evidence and audit fields.  
**Blocks:** Admin override API/UX and exception workflow, not normal matching.  
**Classification:** Slice-specific and a release gate for override features.

### Additional documented design items

- **G5-D11 — Bearer-link lifecycle:** The PRD requires a long-lived tenancy association while keeping the bearer secret revocable/rotatable. Rotation UX and compromise playbook must be resolved in lifecycle design. A revoked secret must never reassign the historical link.
- **G5-D12 — Public submission-page privacy:** The guardrails require restrictive CSP, no analytics, no referrer leakage and no token logging. These are engineering requirements, not discretionary product choices.

## 4. Blocker classification

### Pre-construction blockers

No unresolved decision categorically prevents G5.1 schema design if safe non-operational defaults are enforced. Explicit owner authorization is still required before implementation work begins.

Mandatory early-design constraints:
- No auto-post without verified merchant scope, provider contract and merchant enablement.
- No invented Daraja endpoints or payload semantics.
- No assumed production PII retention period.
- Unresolved financial rules remain explicit and non-operational.

### Slice-specific blockers

| Slice | Dependency |
|---|---|
| G5.1 schema/index design | Neutral merchant placeholders only; do not encode an unverified hierarchy as fact. |
| G5.2 link/notification lifecycle | B07 for SETTLED semantics; B08 for automated unknown-send recovery. |
| G5.3 SMS parser | B04 for timestamp matching; parser fixtures can precede auto-match. |
| G5.4 Daraja callback | B02, B03 and B09. |
| G5.5 Pull recovery | B02 and B03. |
| G5.6 evidence/claims | B01 merchant scope mapping and B04 timestamp rules. |
| G5.7 G3 posting | B06, B07 and proof of G3 behavior. |
| G5.8 production | B01–B05, B09 and operational runbooks. |

### Provider-verification blockers

- B02: exact callback and Pull wire contract.
- B03: actual merchant enablement.
- B09: credential ownership and scope.
- Relevant B04 paired timestamp fixtures.
- B08: Celcom status-query capability.

### Release blockers

- B05: written production retention/privacy policy.
- B01–B03 and B09: merchant identity, channel enablement and credentials proven before automatic posting.
- B10: written policy before any administrative override exists.
- G5.8: monitoring, rollback, credential rotation, provider readiness and operational runbooks.

## 5. Architecture challenge findings

### 5.1 Findings supported by the pinned repository

- `Payment.origin` already includes `MPESA`.
- `Payment.mpesaReceiptId` is an ObjectId field with a unique partial index for ObjectId values.
- `accountingPosting.service.js` implements BANK and MANUAL paths, not MPESA.
- No G5 `Mpesa*` models or Daraja client/product code existed at the pinned baseline.
- The SMS stack is outbound Celcom infrastructure. `SmsMessage.message` stores plaintext and is exposed through history/detail paths in the audited source.
- G3 remains the sole Payment, allocation and Ledger authority.
- G4 banking is provider-specific and must remain isolated from G5 Till collection.

### 5.2 Double-posting risk

Both the SMS-submission path and Daraja callback/Pull path can observe evidence for the same receipt. Neither may create a Payment independently.

The intended mitigation is one canonical M-PESA transaction identity, one claim/consumption path and the existing unique `Payment.mpesaReceiptId` linkage. The existing field must be traced through all callers, index definitions and migrations before implementation. Do not store an external receipt string in an ObjectId field.

G5 must extend the existing G3 posting service. It must not create a parallel poster or ledger.

### 5.3 Wrong-tenancy attribution

The submission link must bind to the exact immutable `Tenancy._id`. It must never infer the target from mutable `Tenant.houseId`, `Tenant.status` or `House.tenantId`.

G4's `tenancyContains()` interval behavior must not be weakened to accommodate G5 closed-tenancy arrears. G5 needs a narrow old-tenancy arrears path using the link's tenancy identity and eligible existing charges.

### 5.4 Bearer-link and SMS security

A permanent or long-lived submission URL is a bearer credential. The existing plaintext `SmsMessage.message` field is not safe for token-bearing URLs without protected payload storage and API/history redaction.

Required controls include token hashing, high-entropy secrets, revocation/rotation, encryption of outbound token-bearing content at rest, redaction from API history and logs, least-privilege access, and careful handling of unknown delivery outcomes. The public page must disclose no tenant identity or financial information before successful token validation.

### 5.5 G3 overpayment and closed-tenancy risks

G3's `planAllocation`, `statusAfterPayment` and closed-tenancy charge-selection behavior require further inspection and tests. Do not assume that a closed tenancy can safely accept every late payment or that an unapplied remainder is represented correctly.

Only existing eligible charges attached to the exact old tenancy may be settled. Excess funds must remain represented or be routed to review. No amount may silently benefit a new tenancy.

### 5.6 Duplication boundaries

Do not repurpose G4 `BankTransaction`, `BankConnection` or `BankCredential` as M-PESA domain records. Adapt transaction-safe ingestion, claims, quarantine, guarded-index, locking and audit patterns without importing bank-provider semantics.

Do not create a second SMS platform or a parallel Payment/Ledger implementation.

### 5.7 Migration and test risks

- Existing `Payment.mpesaReceiptId` has a unique partial index; G5.1 must not introduce a conflicting duplicate definition.
- Financial tests require a disposable `tycoon_test_*` database with real Mongo transaction support, such as a replica set or sharded topology.
- Existing destructive test helpers must never target shared development or production databases.
- Add concurrency coverage for duplicate callback/Pull overlap, repeated SMS submissions, competing claims, stale worker leases and posting rollback.
- Preserve existing G3/G4 regression suites.

### 5.8 Unsupported facts — do not encode as truth

The pinned source does not prove:
- A specific Daraja endpoint path, signature scheme or acknowledgement body.
- Till-to-estate cardinality.
- Numeric SMS/Daraja timestamp tolerance.
- Production PII retention days.
- Complete historical ledger coverage from a zero projection.
- Celcom unknown-delivery query/retry capability.

## 6. Documentation outcome

The G5 PRD, architecture, architecture summary and implementation guardrails remain the design authority. G5-B01–G5-B10 remain unresolved; recommendations in this audit do not constitute owner approval.

The workspace integrity findings are recorded here. No speculative redesign was required by the audit.

## 7. Recommended next slice

After explicit owner authorization, proceed with **G5.1 — schema and index design only**.

The design should specify:
- Exact domain records, fields, types, relationships and ownership.
- Unique/partial indexes and idempotency invariants.
- Submission-link lifecycle, revocation and rotation states.
- Merchant-profile placeholders that remain non-operational pending B01/B02/B03/B09.
- Canonical transaction, evidence and claim relationships.
- The relationship between `Payment.mpesaReceiptId` and the internal canonical transaction identity.
- Migration preflight/readiness and rollback design.
- Concurrency, uniqueness, stale-claim and duplicate-ingestion test cases.

Before G5.7, prove G3 overpayment and closed-tenancy behavior. Before G5.4/G5.5, verify the exact Daraja contract and merchant enablement.

G5.1 design must not create models, run migrations, add routes/jobs, change SMS delivery, implement Daraja, change accounting behavior or enable auto-posting unless a separate explicit authorization expands its scope.

## 8. Final status

| Item | Result |
|---|---|
| Source provenance | Pinned to `204c8f9c3578f753af20727799aaa049b1545135` |
| Initial application-tree copy | Five missing controllers found |
| Integrity restoration | Five controllers restored byte-identically |
| Final checked application tree | 0 missing, 0 extra, 0 content differences |
| G5 product implementation | Not started |
| Owner decisions B01–B10 | Still open |
| G5.1 schema design | Recommended; explicit authorization required |
| Daraja adapters | Not authorized before provider verification |
| Production | Not authorized before G5.8 release gates |

**End of G5.0.1 audit transcription.**
