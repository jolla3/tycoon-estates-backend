# G5.1 — Schema and Index Design Decision Record

**Status:** Documentation-only proposal. No model, migration, index, route, worker, credential, or runtime change is authorized by this document.  
**Prepared against:** `main@204c8f9c3578f753af20727799aaa049b1545135`  
**G5 documentation baseline:** `feature/g5-construction@a927eaca6bd82d387264d8baf42d28b1fc3cb252`  
**Decision class:** PROPOSED unless explicitly marked VERIFIED-SOURCE or OWNER-DECISION.

## 1. Purpose and boundary

This document turns the G5.0 architecture into a reviewable schema/index proposal. It does not authorize implementation. It deliberately avoids fixing merchant identity, credential ownership, provider event identifiers, callback semantics, or pull cursor structure while B01/B02/B03/B09 remain unresolved.

G5 remains Buy Goods / Till receipt attribution. PayBill is outside scope. G3 remains the only authority for Payments, allocations, charge projections, and Ledger movements. No provider call or financial posting is introduced here.

## 2. Design decisions

| ID | Decision | Classification | Consequence |
|---|---|---|---|
| S01 | Use a distinct M-PESA domain; do not reuse G4 bank models as M-PESA records. | OWNER-DECISION / fixed product boundary | No BankTransaction, BankConnection, or BankCredential reuse. |
| S02 | A submission link binds to one immutable `Tenancy._id` and its client/estate/house/tenant snapshot. | OWNER-DECISION / fixed invariant | Current Tenant and House pointers are not attribution keys. |
| S03 | Keep the first model set to five core records: MerchantProfile, SubmissionLink, SmsSubmission, IngestionEvent, and Transaction. | PROPOSED | Do not add a separate PaymentClaim collection initially. |
| S04 | Store the winning claim/lease/posting relationship on the canonical Transaction; preserve competing attempts as SmsSubmissions and audit events. | PROPOSED | Avoid a second record that duplicates a one-transaction/one-winning-claim relationship. Revisit only if later workflows prove an independent claim aggregate is necessary. |
| S05 | Defer Pull checkpoint schema until B02 establishes the actual cursor, window, pagination, and recovery contract. | PROPOSED | No guessed cursor fields or TTL assumptions in G5.1. |
| S06 | A unique canonical transaction key is not final until B01/B02 establish receipt uniqueness scope and merchant/Store identity. | BLOCKED/UNKNOWN | Do not create or rely on a speculative unique index. |
| S07 | Daraja credential storage and reference ownership are not selected until B09 is resolved. | BLOCKED/UNKNOWN | No credential fields, secret records, or startup requirements in the first schema proposal. |
| S08 | Existing `Payment.mpesaReceiptId` remains the internal ObjectId relationship to the canonical M-PESA Transaction, not the external receipt string. | VERIFIED-SOURCE + fixed G5 invariant | Recheck live database index and all callers before implementation. |

### Why no separate MpesaPaymentClaim initially?

The canonical Transaction is already unique by provider receipt identity once the correct merchant scope is known. A single conditional state transition on that record can reserve its one permitted tenancy association and posting lease. It can carry `claimedLinkId`, `claimedSubmissionId`, `matchedTenancyId`, `processingClaimToken`, `processingClaimExpiresAt`, and `paymentId`.

A second submission against another link is still durably represented by its own SmsSubmission and marked as conflict; it must not overwrite the first successful association. The transaction record is the one-winner gate. A separate claim collection would initially duplicate this identity and its state. Reintroduce it only if evidence shows claims need a distinct multi-record lifecycle or independent audit semantics that cannot be represented without bloating Transaction.

### Why no Pull checkpoint model yet?

Pull pagination and checkpoint rules depend on the actual authenticated API contract. A guessed `cursor`, `page`, `fromTime`, or fixed 48-hour window would encode an unverified provider assumption. G5.5 should design a checkpoint model only after B02/B03 and controlled fixtures identify the exact resumable unit.

## 3. Proposed domain records

Collection names below are proposed explicitly to make index and migration discussions concrete. They are not created.

### 3.1 MpesaMerchantProfile — `mpesamerchantprofiles`

Purpose: one Tycoon-owned configuration record for a verified Safaricom Buy Goods merchant context and its allowlisted Tycoon ownership mapping.

Candidate fields:

| Field | Type | Rule / note |
|---|---|---|
| `clientId` | ObjectId → Client | Required; immutable owner. |
| `provider` | String | Fixed `SAFARICOM`; no generic provider abstraction in this first product. |
| `merchantType` | String | Fixed `BUY_GOODS_TILL` for this scope. |
| `displayName` | String | Internal admin label only. |
| `identity` | Strict subdocument | Candidate Till/shortcode/Store/Head Office fields only after B01/B02 confirm meanings and which fields are actually present. |
| `scopeBindings` | Array of strict subdocuments | Candidate mapping from verified provider scope identity to one or more estate/store scopes. Exact keys remain B01-dependent. |
| `callbackCapability` | Enum | `UNKNOWN`, `NOT_ENABLED`, `VERIFIED`; evidence-backed state, not a user-controlled boolean. |
| `pullCapability` | Enum | `UNKNOWN`, `NOT_ENABLED`, `VERIFIED`; evidence-backed state, not a user-controlled boolean. |
| `operationalState` | Enum | Default `DRAFT`; candidate `NOT_READY`, `ACTIVE`, `SUSPENDED`. ACTIVE requires verified configuration and operational gates. |
| `credentialReference` | String, optional | Do not finalize until B09 defines app-vs-merchant ownership and key custody. Never store secret material here. |
| `credentialVersion` | Integer, optional | Only if B09's approved credential model uses versioned references. |
| `createdByUserId`, `updatedByUserId` | ObjectId → User | Audit ownership. |

Important constraints:

- Do not assume one Till maps to one estate. The design must represent an explicit allowlist and must fail closed if one transaction cannot resolve to exactly one permitted scope.
- Do not flatten Till, Store, Head Office, Notification Number, Nominated Number, shortcode, and settlement identity into one field.
- Do not install a unique merchant identity index until B01/B02 prove the identity key and scope.
- Do not store Consumer Secret, access token, initiator password, or any other secret in this document.
- Do not repurpose G4 BankCredential or its bank-only provider enum as a generic secret store.

### 3.2 MpesaSubmissionLink — `mpesasubmissionlinks`

Purpose: one reusable, revocable bearer association for one immutable Tenancy.

Candidate fields:

| Field | Type | Rule / note |
|---|---|---|
| `clientId`, `estateId`, `houseId`, `tenantId`, `tenancyId` | ObjectIds | Required ownership snapshot copied from the exact Tenancy at creation; immutable. |
| `merchantProfileId` | ObjectId → MpesaMerchantProfile | Optional until B01 resolves whether the tenancy has one unambiguous merchant mapping. No link is operational while mapping is ambiguous. |
| `tokenHash` | String | Required digest only; raw bearer token is returned once to notification delivery and is never persisted. |
| `tokenVersion` | Integer | Starts at 1 and increments on rotation. |
| `status` | Enum | `ACTIVE`, `ARREARS_ONLY`, `REVOKED`, `MANUAL_REVIEW`; `SETTLED` is excluded until B07 is resolved and a verified-coverage mechanism exists. |
| `rotatedAt`, `revokedAt` | Date | Nullable lifecycle metadata. |
| `createdByUserId`, `updatedByUserId` | ObjectIds | Nullable actor references for system-created lifecycle events and authorized actions. |
| `lifecycleRevision` | Integer | Optional monotonic CAS token if required after the tenancy lifecycle concurrency design. |

Proposed uniqueness:

- One link association per Tenancy: unique `tenancyId`. Rotation updates the secret/version on the same association; it does not create a new Tenancy or repoint the link.
- Unique `tokenHash` across all links.
- Keep old digests out of the active lookup collection unless the explicit security design requires a non-redeemable audit history. The old bearer token must become unusable after rotation.

A tenancy that maps ambiguously to more than one merchant profile remains non-operational; do not solve that ambiguity by letting the public submitter choose a merchant profile.

### 3.3 MpesaSmsSubmission — `mpesasmsubmissions`

Purpose: record each accepted submission attempt and the deterministic parser result.

Candidate fields:

| Field | Type | Rule / note |
|---|---|---|
| `clientId`, `estateId`, `houseId`, `tenantId`, `tenancyId` | ObjectIds | Immutable snapshot resolved from the link, never from current Tenant/House pointers. |
| `linkId` | ObjectId → MpesaSubmissionLink | Required. |
| `merchantProfileId` | ObjectId → MpesaMerchantProfile | Nullable until merchant identity is resolved unambiguously. |
| `submittedAt` | Date | Server timestamp. |
| `submissionRequestId` | String | Optional request retry key; does not replace transaction/claim uniqueness. |
| `parserVersion` | String | Required for deterministic reproducibility. |
| `parseStatus` | Enum | `PARSED`, `UNSUPPORTED`, `AMBIGUOUS`, `INVALID`. |
| `receiptNumber` | String | External M-PESA receipt string, never an ObjectId. |
| `amountCents` | Safe integer | Parsed amount in integer cents. |
| `currency` | String | `KES` only when explicitly supported by the accepted message template. |
| `transactionAt` | Date | Parsed instant only when format/timezone interpretation is unambiguous. |
| `payerEvidence` | Protected subdocument, optional | Phone/name only if necessary and policy-approved; neither is a tenancy identity key. |
| `rawMessageDigest` | String, optional | Prefer a keyed digest if retained for deduplication; do not expose raw message or derive an unkeyed low-entropy PII fingerprint by default. |
| `rawMessageEnvelope` | Encrypted envelope, optional | Only if B05 retention/access/hold policy approves. Never plaintext. |
| `reconciliationState` | Enum | `PENDING_PROVIDER`, `MATCHED`, `CONFLICT`, `REJECTED`, `MANUAL_REVIEW`. |
| `canonicalTransactionId` | ObjectId → MpesaTransaction | Nullable link to the resolved canonical transaction. |

Privacy rules:

- Do not persist the raw confirmation text in a normal String field.
- Payer name/phone are descriptive evidence only. They are not required to equal the Tenant phone.
- Do not add a TTL duration until B05 defines retention and dispute holds.
- Do not make a raw-message digest unique until canonicalization, key custody, and intended resubmission semantics are defined. The canonical transaction and winning claim remain the financial duplicate barriers.

### 3.4 MpesaIngestionEvent — `mpesainestionevents`

Purpose: durable provider-ingress inbox and quarantine record. This combines the proposed callback inbox and quarantine instead of creating separate collections for normal and rejected callback events.

Candidate fields:

| Field | Type | Rule / note |
|---|---|---|
| `provider` | String | Fixed `SAFARICOM`. |
| `sourceChannel` | Enum | `CALLBACK` or `PULL`; exact event semantics remain B02-dependent. |
| `merchantProfileId` | ObjectId | Nullable until merchant identity resolves. |
| `receivedAt` | Date | Server receipt time, distinct from provider transaction time. |
| `providerEventId` | String, optional | Store only if the actual contract supplies a stable event identity. |
| `payloadDigest` | String | Digest of the exact accepted payload representation; no credentials or auth headers. |
| `payloadEnvelope` | Encrypted envelope, optional | Only if forensic/recovery retention is approved; otherwise retain normalized minimum fields and redacted evidence. |
| `normalizedTransactionId` | ObjectId → MpesaTransaction | Nullable until ingestion succeeds. |
| `state` | Enum | `RECEIVED`, `PROCESSED`, `QUARANTINED`, `FAILED_RETRYABLE`, `FAILED_TERMINAL`. |
| `quarantineCategory`, `reasonCode` | String/enum | Sanitized, bounded diagnostics; no raw request body in logs. |
| `attempts`, `nextAttemptAt`, `processingStartedAt` | Number/Date | Retry scheduling and operational query fields; lease/fencing only where processing can affect financial posting. |

A callback must be durably accepted or quarantined before a successful acknowledgment is returned, but the exact acknowledgment and authentication rules are B02 blockers. The event inbox is not proof of a payment and cannot post to G3.

For Pull, each response item may be recorded through the same ingestion boundary, but a page/window checkpoint is a separate recovery concern. Do not add speculative cursor fields here.

### 3.5 MpesaTransaction — `mpesatransactions`

Purpose: one normalized merchant-side transaction identity to which callback and Pull evidence converge. This is also the one-winner claim and posting coordination record in the initial proposal.

Candidate fields:

| Field | Type | Rule / note |
|---|---|---|
| `clientId` | ObjectId → Client | Required after merchant ownership resolves. |
| `merchantProfileId` | ObjectId → MpesaMerchantProfile | Required before automatic verification/posting. |
| `provider` | String | Fixed `SAFARICOM`. |
| `receiptNumber` | String | External alphanumeric receipt; preserve provider casing/format exactly after schema validation. |
| `amountCents` | Safe integer | Required for a normalized credit candidate. |
| `currency` | String | Explicitly normalized; no silent currency default if provider schema does not establish it. |
| `transactionAt` | Date | Provider transaction instant after verified timezone/precision handling. |
| `direction` / `transactionType` | Strict enum | Required and populated only from the verified Daraja contract; unknown, debit, reversal, or ambiguous values cannot auto-post. |
| `merchantIdentitySnapshot` | Strict subdocument | Preserve only verified Till/Store/shortcode identifiers used to establish scope. |
| `sourceChannels` | Array of enum | Merge callback/Pull provenance without replacing the accepted transaction identity. |
| `sourceEventIds` | Array of ObjectIds | Ingestion events that supplied this transaction. |
| `payerEvidence` | Protected subdocument, optional | Minimize; not part of tenancy matching. |
| `verificationState` | Enum | `UNVERIFIED`, `PENDING_EVIDENCE`, `MATCHED`, `CONFLICT`, `MANUAL_REVIEW`. |
| `claimState` | Enum | `UNCLAIMED`, `CLAIMED`, `REVIEW`, `REJECTED`, `POSTED`. |
| `claimedLinkId`, `claimedSubmissionId`, `matchedTenancyId` | ObjectIds | Set together through one conditional winning claim transition; immutable once committed except a separately authorized correction process. |
| `processingClaimToken` | String | Random fencing token for the current worker claim. |
| `processingClaimExpiresAt` | Date | Lease expiry; must be checked conditionally inside the final G3 transaction. |
| `processingAttempts`, `lastProcessingErrorCode` | Number/String | Bounded operational diagnostics; no raw payload or secrets. |
| `postingState` | Enum | `NOT_POSTED`, `PROCESSING`, `POSTED`, `FAILED_RETRYABLE`, `FAILED_TERMINAL`. |
| `paymentId` | ObjectId → Payment | Set only when the G3 Payment commits in the same MongoDB transaction. |

The winning claim transition must conditionally reserve one canonical transaction for one exact submission/link/tenancy. The final G3 transaction must conditionally consume the current fencing token and write Payment, allocations, charge projections, Ledger, transaction POSTED state, and Payment linkage atomically. A stale worker must not commit after takeover.

## 4. Index proposal

All indexes below are candidates. The actual MongoDB collection indexes must be inspected before relying on them. Model declarations alone do not prove live index presence.

| Collection | Candidate index | Purpose | Readiness |
|---|---|---|---|
| `mpesamerchantprofiles` | `{ clientId: 1, operationalState: 1 }` non-unique | Admin/readiness listing | Can be designed now. |
| `mpesasubmissionlinks` | `{ tokenHash: 1 }` unique | Bearer token lookup and collision barrier | Can be designed now. |
| `mpesasubmissionlinks` | `{ tenancyId: 1 }` unique | One association per immutable Tenancy; rotation updates same record | Can be designed now, subject to confirming the one-link-per-tenancy invariant remains the product rule. |
| `mpesasubmissionlinks` | `{ clientId: 1, estateId: 1, status: 1 }` non-unique | Scoped admin lifecycle queries | Can be designed now. |
| `mpesasmsubmissions` | `{ linkId: 1, submittedAt: -1 }` non-unique | Submission history for a tenancy link | Can be designed now. |
| `mpesasmsubmissions` | `{ reconciliationState: 1, submittedAt: 1 }` non-unique | Pending evidence work | Can be designed now. |
| `mpesainestionevents` | `{ state: 1, nextAttemptAt: 1, receivedAt: 1 }` non-unique | Durable inbox recovery | Can be designed now. |
| `mpesainestionevents` | `{ merchantProfileId: 1, sourceChannel: 1, receivedAt: -1 }` non-unique | Provider provenance queries | Can be designed now. |
| `mpesainestionevents` | `{ merchantProfileId: 1, providerEventId: 1 }` unique partial | Event replay dedupe only if a stable provider event ID is guaranteed | BLOCKED by B02. |
| `mpesatransactions` | `{ merchantProfileId: 1, receiptNumber: 1 }` unique | Callback/Pull canonical identity | BLOCKED by B01/B02; exact uniqueness scope must be proven. |
| `mpesatransactions` | `{ postingState: 1, processingClaimExpiresAt: 1 }` non-unique | Reconciliation/recovery lease scans | Can be designed now. |
| `mpesatransactions` | `{ verificationState: 1, transactionAt: -1 }` non-unique | Pending transaction review | Can be designed now. |
| `payments` | Existing unique partial `{ mpesaReceiptId: 1 }` for ObjectId values | One Payment per internal canonical Transaction ID | VERIFIED-SOURCE schema declaration; live DB definition must be inspected. |

### Indexes deliberately not proposed yet

- No unique merchant identity key until B01/B02 determine the true identity tuple and scope.
- No unique receipt key on external receipt alone.
- No unique SMS digest key until digest construction and resubmission semantics are proven.
- No Pull checkpoint unique key until B02 identifies the checkpoint unit.
- No TTL index for links, SMS submissions, provider events, or transactions while B05 retention/dispute rules are unresolved.
- No separate unique `MpesaPaymentClaim` index because the initial design stores the one-winning claim on MpesaTransaction.
- No new Payment index until existing database index options and data are inspected. Reuse the existing `mpesaReceiptId` identity path.

## 5. Existing G3 contracts to preserve

Verified in source at the pinned baseline:

- `Payment.origin` already includes `MPESA`.
- `Payment.mpesaReceiptId` is an ObjectId with a unique partial index declaration for ObjectId values; it currently has no Mongoose `ref` declaration.
- `accountingPosting.service.js` has BANK and MANUAL idempotency paths, not MPESA.
- G3 writes the full Payment amount to the tenancy Ledger. Charge allocations may be lower than the received amount; the returned result exposes `unappliedCents`.
- `ledgerService.balanceForTenancy()` returns tenancy-scoped `knownCreditCents` but keeps historical coverage `UNVERIFIED`.
- G3 serialization uses Tenancy `ledgerRev`, allocation revisions, unique source references, and Mongo transaction sessions.

Implementation must not:
- store the external receipt string in Payment.mpesaReceiptId;
- write Payment, PaymentAllocation, RentCharge projections, or Ledger outside G3;
- create a separate M-PESA Ledger or wallet;
- weaken G4's date-based `tenancyContains()` rule;
- auto-transfer or spend a former tenancy's credit.

Before G5.7 auto-post, real Mongo integration tests must cover closed-tenancy arrears with excess, OVERPAID-only rows, no eligible charges, and a later tenancy in the same House. B06 remains an owner policy gate.

## 6. Index/migration/readiness plan

1. Migration preflight is read-only by default.
2. Inspect the actual live `payments.mpesaReceiptId` index name, key, unique flag, partial predicate, collation, and any conflicting same-key index.
3. Scan existing Payment data for malformed values and duplicate ObjectId references before relying on the existing unique constraint.
4. For every new unique index, perform a duplicate preflight against the exact candidate key and partial filter before creating it.
5. Execute index mutations only through an explicit guarded migration with target database and host allowlists. No index creation/drop/rebuild during normal server startup.
6. Add read-only runtime readiness that compares exact index name/key/order/unique/partial predicate. Financial posting remains fail-closed if required identities are absent or misaligned.
7. Keep ordinary query indexes separate from financial identity indexes. Query indexes may be installed through the reviewed migration strategy; they must not silently create or replace unique financial constraints.
8. Never use `dropIndexes`, blanket index cleanup, or automatic receipt conversion.

The G4 migration scripts are precedent for explicit opt-in additive migrations, but their weak preflight pattern must not be copied blindly. G3 financial index migrations with duplicate scans and strict database allowlists are the stronger pattern to follow.

## 7. Open decisions and gates

| Decision | Design consequence |
|---|---|
| B01 merchant hierarchy and Till/Store scope | Merchant profile identity tuple, scopeBindings shape, link-to-profile cardinality, and transaction uniqueness. |
| B02 callback/Pull contract | IngestionEvent identity, callback acceptance semantics, normalized fields, Pull checkpoint design. |
| B03 merchant enablement | Merchant profile remains non-operational until verified. |
| B04 timestamp semantics | No final match predicate or tolerance until fixtures and owner approval. |
| B05 raw SMS/payer PII retention | Whether encrypted source envelopes/PII fields are retained and for how long; no TTL assumption. |
| B06 credit treatment | G3 representation is verified; refund/spend/apply-later/review policy remains owner-owned. |
| B07 historical coverage | No SETTLED transition until a verified coverage result or approved attestation exists. |
| B08 Celcom unknown send | No blind retry; protected outbox recovery policy remains blocked. |
| B09 Daraja credential ownership | No credential storage model or credential-reference ownership is selected. |
| B10 admin exception without SMS | No bypass of the two-evidence automatic posting rule. |

Technical gates:
- G5-D13 public route must use a narrowly mounted bearer-only boundary and must not depend on CSRF/session. **Recommended default:** fail closed for bearer submission when the shared abuse limiter is unavailable, unless an independently verified upstream rate-limit/WAF layer provides equivalent enforcement. This recommendation is PROPOSED, not an owner-approved exception or implementation detail.
- G5-D14 protected SMS must use session-aware outbox insertion and durable dispatch attempt/lease recovery. Unknown external outcome must not be retried blindly.
- G5-D15 moved_out lifecycle writes must become atomic before link transitions are added. Demo seed Tenancy creation must be no-send.

## 8. G5.1 exit criteria

G5.1 DESIGN is complete when:
- the five-record logical model and decision not to create a separate claim collection are independently reviewed;
- merchant/profile cardinality and receipt uniqueness remain clearly provisional pending B01/B02;
- no provider contract, credential ownership, timestamp tolerance, or retention duration is invented;
- indexes are classified as implementable-now, provisional, or blocked;
- the Payment ObjectId link and G3 posting extension boundary are explicit;
- migration preflight/readiness behaviour is specified;
- PRD, architecture, summary, and guardrails point to this design record.

G5.1 APPLICATION IMPLEMENTATION remains NO-GO until the owner gives explicit authorization for that specific slice. A design GO is not a code authorization.

## 9. Review verdict

**GO for G5.1 schema/index DESIGN ONLY.**  
**NO-GO for G5.1 application implementation or migrations.**

This is a proposal for review. It is not proof of live merchant capability, final database index state, or production readiness.
