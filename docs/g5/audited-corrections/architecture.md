# G5 Collection and Rent-Lifecycle Corrections
**Status:** Stress-tested target architecture; design contracts expanded; implementation not started  
**Repository baseline:** main at 2a291df091d35172f75b067acfca94179a3ebb36  
**Workspace:** docs/g5-audited-corrections-readiness

## 1. Architecture objective

Correct the existing flow from House billing configuration through registration messaging, rent obligation generation, receipt attribution, settlement, credit and Payments reporting. Reuse current G3/G5 models and services. Do not create a parallel billing or accounting system.

This document describes the target corrections and the constraints that must be preserved. It does not authorize migrations, production provider calls, SMS sends, feature-flag changes or financial posting enablement.

## 2. Current audited baseline

The following source observations were verified against main at the baseline above.

| Area | Current implementation | Audited gap |
|---|---|---|
| Tenant registration | tenantService.create creates Tenant and Tenancy in one transaction, then queries current-period RentCharge rows for SMS text. | Newly created tenancy may have no RentCharges yet even though its House already has billing configuration. |
| House billing resolution | rent.service.js has private planLinesForHouse(house, period, {session}) for HOUSE_TYPE, HOUSE_CONFIG, MONTHLY_RENT, UNCONFIGURED and fail-closed LEGACY_UNCLASSIFIED. | Registration cannot directly use this private resolver; extracting shared resolution must preserve effective-date and write/concurrency semantics. |
| D-5 reminder | smsReminder.job.js computes Nairobi today + 5 days and selects open positive-balance RentCharges by saved dueDate. | Timing is correct. Existing aggregation can group custom OTHER descriptions into generic Other. |
| Shared settlement | tenantCredit.service.js exposes settleTenantAccount for credit-first, oldest-first settlement and immutable credit movements. Manual and M-PESA use it. | Bank still uses the older accountingPosting path. |
| Bank reconciliation | reconciliation.service.js validates transactionDate against a Tenancy, calls ensureChargesForHouse, reads one tenancy's outstanding charges and calls accountingPostingService.postConfirmedPayment. | Charge generation can block advance receipts; older allocation path differs from shared tenant-credit settlement. |
| M-PESA posting | mpesaPosting.service.js uses settleTenantAccount under a receipt posting fence. PayBill reference evidence checks identity and ACTIVE status. | PayBill does not check transactionAt against tenancy interval; Till evidence path also needs exact tenancy coverage validation. |
| Payments overview | payment.service.js combines non-child Payment rows and ManualReceipt envelopes. | M-PESA and Bank canonical receipts and credit-only/split outcomes are not consistently represented as one receipt-level row. |
| Staff UI | Backend staff update/deactivate operations exist. | Frontend mobile staff cards omit Edit and Activate/Deactivate controls. |

The reminder job source hash at this baseline is 63799ba247078ad56ed620a64ad81fa447c4a659. The exact source must be rechecked before implementation because the workspace branch may advance.

## 3. Domain boundaries and source of truth

Keep these concepts separate:

1. **Configured billing plan:** what the House is configured to charge, resolved from the House billing source and effective configuration.
2. **Generated obligation:** a RentCharge for a specific tenant, tenancy, period and line.
3. **Received receipt:** canonical external/manual evidence that money was received.
4. **Allocation:** the part of a receipt or existing credit applied to a RentCharge.
5. **Tenant credit:** immutable movements representing surplus money or credit application.
6. **Notification:** an informational message based on the correct source for its purpose.

No source may be substituted for another:
- Registration plan SMS uses House billing configuration.
- Rent reminders use actual RentCharge balances and saved dueDate.
- Financial settlement uses canonical receipt evidence plus shared tenant-account settlement.
- Payments overview starts from canonical receipt envelopes and joins their accounting effects.

## 4. Registration billing snapshot architecture

### 4.1 Existing flow

tenantService.create owns a Mongo transaction. It loads the House and Estate in scope, creates Tenant and Tenancy, then queries RentCharge for the new tenancy and current YYYY-MM period. If no rows exist, it sends a generic unavailable message. When rows exist, aggregateRentCharges groups amounts and may reduce custom OTHER labels to Other.

This is the wrong source for the registration plan. It also risks implying that a generated charge statement is the same thing as the House's configured recurring plan.

### 4.2 Target flow

1. Keep the existing caller-owned registration transaction and exact House/Estate ownership checks.
2. Resolve the billing plan from the House's explicit billingSource.
3. Use the same canonical billing-source rules as rent generation. Do not duplicate HouseType/HouseBillingConfig/MonthlyRent mapping in tenant.service.js.
4. Evaluate the informational snapshot as of the registration date. The monthly charge-generation resolver must continue evaluating the plan for the target YYYY-MM period.
5. Preserve source line description, charge type, amount and due day. Render each line distinctly.
6. If the source is UNCONFIGURED, say the House has no configured billing plan. If LEGACY_UNCLASSIFIED or invalid, say the plan cannot be verified. Do not guess a fallback.
7. Do not create RentCharges or Ledger rows from registration. Do not report Paid, Outstanding, arrears or invoice-issued status from plan configuration.
8. Queue the existing ordinary/protected registration SMS using the existing transaction and outbox rules. Preserve the current M-PESA eligibility, link encryption, message protection and post-commit dispatch mechanics.

### 4.3 Resolver extraction constraints

planLinesForHouse is currently private to rent.service.js. It is the best existing source-resolution implementation, but it is not automatically safe to call as-is from registration:
- HOUSE_CONFIG currently selects configuration using the start of the requested month. Registration snapshots instead evaluate effective-dated rows at one captured registrationAt instant.
- HOUSE_TYPE plan versions are period-effective only (effectiveFromPeriod); they cannot answer a day-level historical question. When history exists, registration uses the latest version effective for the registration YYYY-MM. If there are no version-history records at all, registration uses the linked HouseType's canonical `defaultBilling` lines; this does not invent a historical effective period or backfill version history. If history exists only for future periods, no current plan applies.
- The resolver has HouseType/billingPlanRev concurrency/write behaviour. A shared pure resolver extraction must not accidentally remove or bypass required write fencing.
- The registration transaction must pass its existing Mongo session through every read/write.
- Explicit House billingSource values remain authoritative. For registration only, a legacy `LEGACY_UNCLASSIFIED` House with a non-null `houseTypeId` resolves through that exact linked HouseType; the same legacy source without a HouseType link remains fail-closed. Do not infer HOUSE_CONFIG or MONTHLY_RENT from unrelated fields.
- The compatibility fallback is registration-only. CHARGE_PERIOD resolution retains its current legacy-source gate and HouseType version/write-fence behaviour.

Recommended design: separate the shared source-resolution core from charge-generation side effects. Expose an explicit discriminated context: {kind: REGISTRATION, registrationAt} or {kind: CHARGE_PERIOD, period}. Do not overload a string period to mean both instants and months. Registration captures registrationAt once before the retryable transaction and passes the same instant/session through each read. HOUSE_CONFIG uses its current timestamp interval semantics; HOUSE_TYPE remains YYYY-MM period-effective; MONTHLY_RENT snapshots current House fields. No fallback to a different declared billing source is permitted; the only compatibility resolution is the explicit linked-HouseType rule for registration-only LEGACY_UNCLASSIFIED records.

Return an explicit resolution outcome, not only lines: []. Distinguish UNCONFIGURED, LEGACY_UNCLASSIFIED without an explicit HouseType link, NO_EFFECTIVE_HOUSE_TYPE_VERSION when existing history is future-only, a legacy HouseType with no version history resolved from defaultBilling, HOUSE_CONFIG_NO_EFFECTIVE_ROWS (and future-only rows where present), a valid empty HouseType plan, zero-value HouseBillingConfig lines, and MONTHLY_RENT with a zero amount. HouseBillingConfig is line-per-row and has no parent empty-plan record; do not invent one. Do not silently translate these states into explicit UNCONFIGURED. Resolve due day per line using line → House → Estate default → 5, preserving month-end clamping for actual generated due dates. A registration plan message can describe this policy but cannot assert a RentCharge due date.

Keep all current period charge generation semantics, HouseType billingPlanRev write point, readiness gates and session requirements unchanged. Registration must never call ensureChargesForHouse or generateChargesForEstate.


### 4.4 Snapshot resolution contract

- Capture registrationAt = new Date() once for the registration request before session.withTransaction(). The transaction callback may retry; it must not acquire a later timestamp on retry. Do not substitute data.moveInDate, which may be historical or future.
- Pass the exact House, Estate, client scope and current Mongo session into every source read. The registration SMS remains in the same caller-owned transaction/outbox lifecycle.
- HOUSE_CONFIG: evaluate rows at registrationAt, preserving inclusive effectiveFrom, exclusive effectiveTo, and the resolver's active/retired history semantics. The monthly charge-generation context remains period-start based. A config entered after the registration event is not retroactively inserted into the snapshot.
- HOUSE_TYPE: when version history exists, resolve latest effectiveFromPeriod <= dateUtil.periodOf(registrationAt). The model cannot distinguish two dates inside one period. If there are no version-history records at all, use the exact linked HouseType's canonical `defaultBilling` lines for registration; do not infer an effectiveFromPeriod from createdAt or backfill history. If future-only version history exists, do not use `defaultBilling` early. This fallback does not change CHARGE_PERIOD generation.
- MONTHLY_RENT: snapshot current House.monthlyRent. No history model is present in the audited source.
- Line due-day display uses existing resolveDueDay(line.dueDay, house.dueDay, estate.defaultDueDay, 5). The actual RentCharge.dueDate is only materialized by normal charge generation and applies existing month-end clamping.
- Render configured line descriptions, type and amount as an informational plan. A zero-value HouseBillingConfig line must not be mistaken for a missing configuration; render it as a configured zero/no-charge line. HouseTypePlanVersion can have a valid empty lines array, while HouseBillingConfig has no parent empty-plan record. Never add configured values into a paid/outstanding total.
- No applicable HouseType version and no effective HouseBillingConfig rows are explicit no-effective-plan outcomes, not a different-source fallback and not necessarily explicit UNCONFIGURED.

## 5. Rent generation and reminder architecture

### 5.1 Calendar invariants

- Business timezone remains Africa/Nairobi.
- Accounting period remains YYYY-MM.
- Existing full-calendar-month tenancy eligibility remains the gate for monthly charge generation.
- No partial-month proration is introduced.
- Due dates remain persisted on RentCharge and use the existing month-end clamping and date utilities.

### 5.2 D-5 reminder

The existing selector is correct:
- compute Nairobi target day as current Nairobi date + 5 calendar days;
- select only UNPAID/PARTIAL charges with balanceCents > 0 and saved dueDate in that Nairobi day;
- validate the charge against its exact active Tenancy;
- group by tenant, tenancy, period and due date;
- include previous arrears according to the existing reminder policy;
- use the D-5 idempotency identity;
- schedule selection daily at 09:00 Africa/Nairobi;
- dispatch ordinary queued SMS independently every 60 seconds.

Do not move the trigger to the due date. Do not add a second reminder-day setting or reinterpret dueDay. dueDay configures the charge's due date; D-5 is a lead-time calculation from the saved charge dueDate.

### 5.3 Description preservation

The current aggregate helper is suitable for numeric totals but not sufficient as the only rendering representation when distinct custom descriptions matter. Introduce a line-level rendering projection from selected RentCharges with {rentChargeId, chargeType, description, outstandingCents}. outstandingCents is the positive saved balanceCents, not amountDueCents, original plan amount or amount paid. Retain the association to the exact source RentCharge for audit/debugging.

Keep numeric type totals only as optional secondary summaries; they cannot replace named line entries. Distinct OTHER descriptions (e.g. Security, Refuse, Parking) render as distinct labels. Use a deterministic sort: existing charge-type priority, normalized description, then charge ID. Do not merge by type or silently collapse repeated labels. The model's charge identity already prevents duplicate same-type/same-description lines for a single tenancy-period; still handle legacy duplicates deterministically rather than losing money.

The D-5 message's selected-period lines are named. Prior-period arrears remain one separate aggregate under the existing policy and must not be presented as if each old charge were in the current due-date group. If the complete line-level message exceeds an enforced queue/provider limit, fail visibly with an operational reason; no silent truncation or incomplete financial statement. Do not introduce a new multipart-SMS subsystem in this correction.

Reminder amounts are derived only from positive outstanding balances on selected RentCharges, never from House plan amounts.


## 6. Shared settlement architecture

### 6.1 Canonical settlement service

tenantCredit.service.js settleTenantAccount is the shared financial policy:
- serializes Tenant and Tenancy/RentCharge ledger revisions;
- applies existing tenant credit according to the established policy;
- allocates new receipt money across eligible obligations using the shared cross-tenancy planner;
- creates Payment and PaymentAllocation rows for receipt allocations;
- records surplus as immutable TenantCreditMovement;
- preserves integer-cent conservation and transaction atomicity.

Manual and M-PESA already use this service. Bank should converge on it rather than retaining a second posting engine.

### 6.2 Bank correction

Current Bank path:
1. validates the BankTransaction and exact tenancy;
2. calls ensureChargesForHouse for the current period;
3. queries outstanding charges for one tenancy;
4. calls accountingPostingService.postConfirmedPayment.

The correction must remove the assumption that charge generation is a prerequisite for accepting money. Validate the exact Tenancy interval using BankTransaction.transactionDate, then call settleTenantAccount with Bank receipt provenance. If no applicable charge exists, or receipt money exceeds obligations, preserve the excess as tenant credit.

Do not reject a valid advance payment merely because the due date is later or because a monthly RentCharge has not yet been generated.

### 6.3 Bank receipt identity and schema decision gate

The current Payment.bankTransactionId index is unique sparse, while shared settlement may produce multiple child Payments for a single receipt across obligations/tenancies. BankTransaction does not yet expose the same child-payment/credit summary shape as M-PESA.

Before implementation, decide and document:
- canonical Bank receipt envelope identity;
- one-to-many relationship from BankTransaction to settlement child Payments;
- Bank provenance on TenantCreditMovement;
- idempotency and repair semantics when the receipt has no Payment children because all money became credit;
- migration and index transition strategy, including duplicate preflight and old-data compatibility.

Do not simply remove the unique index or make it non-unique without proving every dependent query and idempotency invariant. Do not create one fake Payment for surplus merely to force the receipt into the Payments list. Receipt identity belongs on the receipt envelope.

Bank processing claim tokens, provider+providerTransactionId identity, transactionDate/valueDate distinction and reconciliation audit states must remain intact.

### 6.4 Required BANK source contract and receipt envelope

The current settleTenantAccount source switch supports MANUAL and otherwise assumes MPESA. Bank cannot call it safely by passing a generic receipt today. Extend the shared service with an explicit source discriminator (MANUAL | MPESA | BANK) and source-specific validation/provenance. Do not weaken existing Manual/M-PESA contracts.

Source attribution and allocation are different identities. BankTransaction.matchedTenancyId (plus matched Tenant/House, client and estate) identifies the tenancy that covers transactionDate. Revalidate this exact source tenancy and use transactionDate, never valueDate, for date coverage. Once proven, settleTenantAccount may allocate receipt money across eligible charges in other tenancies of the same {clientId, estateId, tenantId} account, including closed historical tenancies. The credit account is estate-scoped; it must never cross estates. Each child Payment retains the destination tenancy/House of the obligation it settles.

Target envelope contract: BankTransaction remains the canonical gross receipt. It must persist or deterministically reconstruct:
- receipt-origin child paymentIds (zero, one or many);
- credit-application child creditPaymentIds;
- creditMovementIds associated with this settlement attempt;
- receiptAppliedCents, creditAppliedCents, and newCreditCents;
- stable posted-at/result identity sufficient for idempotent replay.

Payment.bankTransactionId currently has a unique sparse index, which conflicts with multiple receipt-origin children. The target must permit one child per destination Tenancy for one Bank receipt, with a deterministic identity (candidate: unique {bankTransactionId, tenancyId} for receipt-origin BANK children, or a dedicated receipt-allocation key). Validate this candidate against historical data and every reader before migration; do not simply drop uniqueness. Credit-application Payment rows are origin=CREDIT, not additional Bank receipts, and should not be counted among paymentIds for gross receipt allocations.

Add Bank source provenance to TenantCreditMovement. For RECEIPT_SURPLUS, it identifies the new money's originating Bank receipt. For CREDIT_APPLIED, the same receipt ID may record which settlement operation triggered consumption of pre-existing credit, but it must remain explicitly classified as old credit, not receipt-origin money. Keep deterministic idempotency keys unique under {clientId, estateId, tenantId}.

Atomic claim protocol: retain the current Bank claim token/expiry and provider+providerTransactionId uniqueness. In one Mongo transaction: re-read exact transaction and source tenancy; verify transactionDate; run shared settlement; write child/movement references and the three settlement totals to the envelope; conditionally consume/finalize the exact still-unexpired claim token as POSTED. A stale token must abort the whole financial transaction. A replay of POSTED returns the persisted result; a valid expired claim may be reclaimed only through the existing claim rules. Never trust an in-memory prior response as proof of posting.

No-charge/advance receipt: if there are no eligible RentCharges, all gross money becomes estate-scoped tenant credit. Do not call ensureChargesForHouse to manufacture the current period's charge merely to accept the receipt. Do not create a fake Payment marker for a surplus-only Bank receipt.

Migration gate: preflight existing Bank Payment rows for duplicate receipt links and candidate receipt+destination-tenancy identities; backfill envelope references only where source ownership and amounts reconcile. Review legacy unapplied amounts/OVERPAID balances separately. No historical reallocation or credit creation is authorized by this documentation. Migration needs dry-run evidence, old-reader compatibility, guarded rollout and rollback/recovery before any index change.

## 7. M-PESA tenancy coverage

### 7.1 Required invariant

A receipt can only be attributed to a tenancy whose date interval covers the provider transaction timestamp. Use the repository's canonical date-boundary convention and exact client/estate/tenant/house/tenancy identity.

The transaction timestamp is not the processing timestamp. A receipt can be delivered or processed later than it was paid.

### 7.2 PayBill path

evaluateReferenceEvidence currently checks:
- active reference;
- operational PayBill profile;
- matching merchant/client/mapping;
- provider transaction type and MATCHED verification;
- amount agreement;
- exact tenancy identity;
- current tenancy status ACTIVE.

It does not establish that txn.transactionAt falls within tenancy.startAt/endAt. The reference already pins the exact tenancy, so validate that interval and all ownership fields. Persist that reference tenancy as canonical MpesaTransaction.attributedTenancyId during fenced posting. The reference lifecycle retires a reference on tenancy closure; a retired reference remains tied to its original tenancy and cannot be reassigned.

Do not replace current status validation with date validation and auto-post every closed-tenancy receipt. A retired reference, closed tenancy, delayed callback and current posting policy interact. Preserve the canonical receipt and reference evidence. Historical closed-tenancy receipts go to review unless a separately approved G3 historical-posting policy authorizes posting. That policy is not created by this correction.


### 7.3 Till/link path

The Till evidence path's MpesaSubmissionLink and MpesaSmsSubmission are tenant+estate scoped and contain no tenancy/house identity. Therefore do not load a tenancy by guessing from the link. Resolve candidates from {clientId, estateId, tenantId} and txn.transactionAt over historical Tenancy rows in ACTIVE or CLOSED state, excluding VOID:
- exactly one row whose interval satisfies startAt <= transactionAt < endAt (or has null endAt) is required;
- zero candidates or multiple candidates (including overlapping historical data) are a review outcome, never an automatic rejection followed by reassignment to another Tenant;
- validate the source House via the selected Tenancy and persist attributedTenancyId on the canonical MpesaTransaction under its first-valid attribution/posting fence.

The interval query alone is not enough. Re-read and write-fence the selected Tenancy in the final posting transaction so a concurrent close/transfer cannot change the attribution between resolution and commit. Preserve the M-PESA receipt lease token; final receipt update must match the same token and valid lease. Attribution is immutable once committed.

A submission with valid acceptedAt/acceptedLinkVersion proof remains processable after link rotation/revocation under the existing link rules. This proof establishes the accepted submission/link version only; it does not establish that the provider transaction time belongs to a tenancy. Both gates must pass independently.

A transaction time covered by a now-closed tenancy is historically attributable but is review-only unless a separate approved historical-posting policy authorizes automatic posting. A provider timestamp before start, at/after exclusive end, invalid, or covered by overlapping tenancies never auto-posts.


### 7.4 Receipt attribution versus allocation Tenancy

Persist the distinction explicitly:
- Source/attribution Tenancy: the exact historical tenancy whose interval proves the receipt belongs to this tenant, estate and house at provider transactionAt. For PayBill it comes from the immutable collection reference and is copied to MpesaTransaction.attributedTenancyId; for Till it is uniquely resolved by timestamp and persisted to that same canonical field. This new canonical field is required for both posting paths.
- Allocation destination Tenancies: any eligible obligations returned by the estate-scoped shared account allocator. They may include older closed tenancies and may differ from the source Tenancy. The corresponding child Payment and PaymentAllocation retain each destination Tenancy's own House/period/charge identity.

Do not force all child allocations onto the source Tenancy. Do not use an allocation child as the authority for which Tenant/estate received the provider receipt. M-PESA posting must retain attributed Tenant/Estate/Tenancy independently of paymentIds, including when the receipt is fully surplus and has no child Payments.

## 8. Canonical Payments overview

### 8.1 Current gap

The current list combines non-child Payment rows with ManualReceipt envelopes. It excludes manual child rows but does not consistently join MpesaTransaction and BankTransaction canonical envelopes with their child Payments and credit movements. An M-PESA receipt that produces no Payment child because all value becomes credit can therefore disappear from the general Payments overview.

### 8.2 Target read model

Build a receipt-centric read model from canonical source envelopes:
- ManualReceipt;
- MpesaTransaction;
- BankTransaction.

Each receipt appears once. Join:
- receipt child Payment IDs;
- PaymentAllocation rows;
- credit movements earned by the receipt;
- credit movements consumed by allocations, where applicable;
- exact credited tenant, House, Estate and receipt ownership context.

Expose gross received separately from:
- amount from this receipt applied to charges;
- existing credit consumed (not new money);
- new credit earned from this receipt;
- resulting outstanding/credit position.

Do not infer actual payer identity from credited Tenant. If payer details are not recorded and verified, omit them. Do not create a false payer field.

Preserve estateFilterClause/client authorization and historical receipt ownership. Do not derive historical estate from the tenant's current House pointer.

The list endpoint needs validated pagination/filter query inputs and stable sorting. Keep source-envelope aggregation bounded and indexed; avoid N+1 per-row lookups. Query design and index requirements must be profiled before implementation.

### 8.3 Envelope eligibility, historical ownership and current balance

The receipt overview is not a provider-ingestion or reconciliation queue. Include only:
- ManualReceipt with its confirmed status;
- MpesaTransaction whose postingState is POSTED and whose exact attributed client/estate/tenant context is present;
- BankTransaction whose processingState is POSTED and whose matched source Tenancy/tenant/house context was verified.

Do not include unallocated M-PESA receipts, unmatched Bank rows, Bank debits, or M-PESA/Bank records in processing, failed or review states as tenant receipts. They remain in their existing provider/reconciliation review surfaces. A fully-surplus POSTED receipt still appears once without any Payment child.

A CREDIT-origin Payment is not an incoming receipt and must not produce a second receipt row. It may remain visible in account/allocation detail. For each canonical receipt, join only receipt-origin child Payments and associated movements; use the receipt envelope as row identity.

At envelope level use the historical source House/attribution Tenancy. ManualReceipt already has houseId and occupancyTenancyId; Bank uses its matched source House/Tenancy; M-PESA derives source House from the persisted attributed Tenancy. Allocation details may list other destination Houses/Tenancies.

Calculate independently:
- receiptAppliedCents: sum of receipt-origin allocations for this envelope;
- newCreditCents: surplus movement created by this envelope;
- creditAppliedCents: existing tenant credit consumed during this settlement attempt, not new receipt money.
Assert gross = receiptApplied + newCredit and creditBefore = creditApplied + creditRemaining. Do not use a child Payment amount as gross receipt authority.

Remaining account position is current {clientId, estateId, tenantId} credit/outstanding position at query time. Label it as current. Do not call it the balance immediately after this historical receipt unless a posting-time snapshot is persisted.

### 8.4 Query, pagination and index contract

Validate IDs, dates, status/method filters and pagination before building aggregation pipelines. Reject malformed ObjectIds and invalid date ranges with the normal request-validation response. Normalize source-specific timestamp fields to one read-model receivedAt, sort by receivedAt DESC, envelopeId DESC, and apply pagination after all canonical envelope sources are unioned so totals and page boundaries are consistent.

Every branch of the union must apply client scope and authorized estate scope before producing rows. Use the envelope's estateId and source-tenancy relationship for historical ownership; do not query Tenant.current house/estate as a fallback. Batch relationship loading for the page, not N+1 queries. Profile actual query plans and add only justified compound indexes (especially client+estate+received-time on each source). Existing M-PESA indexes on allocation fields may not cover new attributed fields; prove index readiness before relying on them.

## 9. Staff mobile UI

The backend source has update/activate/deactivate operations with client scope and self-deactivation protection. The claim that the separate frontend mobile card omits controls has not been independently reverified in this stress-test pass: the frontend repository, branch, exact component path and test harness were not retrieved.

Before implementation, record the exact tycoon-frontend GitHub repository, baseline commit, file path and desktop/mobile render branches. Then add the same permitted Edit and Activate/Deactivate actions to the mobile card layout, preserving responsive layout and existing action confirmation/feedback. Do not duplicate authorization rules in the frontend or add backend endpoints. Frontend acceptance is not complete until the actual mobile viewport/component interaction tests run in that repository.


## 10. Data flow summary

### Registration
House + explicit billingSource
→ resolve plan effective on registration date
→ create Tenant + Tenancy in existing transaction
→ render named informational plan lines
→ queue standard/protected SMS through existing outbox
→ commit
→ dispatcher sends after commit.

### Monthly billing and reminder
Full-calendar-month eligible Tenancy
→ existing period-based House plan resolver
→ RentCharge + Ledger
→ payment/credit settlement updates balances
→ D-5 selector checks saved RentCharge.dueDate = Nairobi today + 5
→ named outstanding lines in SMS queue
→ independent dispatcher.

### Receipt settlement
Canonical Manual/Bank/M-PESA receipt
→ verify exact ownership and transaction-time tenancy coverage
→ shared settleTenantAccount
→ Payment/PaymentAllocation children + immutable credit movements
→ canonical receipt envelope records settlement references
→ receipt-centric Payments read model shows one row and its breakdown.

## 11. Failure modes and design challenge

| Risk | Required disposition |
|---|---|
| Registration plan resolver changes charge generation semantics | Separate resolution context from charge-generation side effects; retain period-based behaviour and session/write fences. |
| EffectiveFrom causes same-month config to be missed | Explicitly test registration-date snapshot versus period-effective charge generation. Do not backdate config silently. |
| D-5 timing accidentally changed while fixing labels | Add regression test for due date 17th -> selected 12th in Nairobi. |
| Custom descriptions lost in numeric aggregation | Keep line-level descriptions alongside totals. |
| Bank receipt splits into multiple child Payments | Define canonical receipt-to-many child identity before index changes. |
| Entire Bank/M-PESA receipt becomes credit and has no Payment child | List the canonical receipt envelope independently of child Payment presence. |
| Till link does not identify a tenancy | Resolve exactly one timestamp-covering tenancy for tenant+estate; zero/multiple candidates go to review; persist immutable attributedTenancyId. |
| Receipt source tenancy differs from allocation Tenancy | Store source attribution on the canonical envelope; allow shared allocator to settle eligible same-estate obligations across other tenancies. |
| Closed tenancy callback arrives late | Validate transaction date and preserve attribution evidence; closed historical receipts stay review-only absent a separately approved G3 historical-posting policy. |
| HouseType current-period version is created mid-month | Preserve existing period-effective rule; do not claim day-level effectiveness. A day-level product change is separate. |
| Receipt list exposes unallocated or unmatched provider rows | Restrict tenant receipt view to confirmed/posted envelopes with verified tenant/estate attribution. |
| Current balance is mistaken for historical receipt balance | Label it as current-at-query-time unless a posting-time snapshot is persisted. |
| Existing credit is reported as new money | Separate gross receipt, credit consumed and credit earned. |
| Payments query widens estate scope | Retain server-side client/estate filters and test forbidden cross-estate reads. |
| Frontend hides actions at narrow breakpoints | Add mobile viewport component tests and preserve backend permissions. |

### Overengineering explicitly rejected

- No second settlement engine or separate Bank credit calculator.
- No new wallet or mutable Tenant balance field.
- No replacement of the YYYY-MM period model.
- No reminder configuration system to replace the already-correct D-5 rule.
- No automatic charge generation during registration just to populate an SMS.
- No speculative unique-index change before receipt identity is designed.
- No frontend-only trust or authorization logic.

## 12. Implementation sequence

1. Reconfirm exact backend and frontend repository baselines and current diffs before coding.
2. Lock and test the source-specific House snapshot contract (HOUSE_CONFIG instant; HOUSE_TYPE period; MONTHLY_RENT current fields), registration timestamp capture, due-day fallback and no-effective-plan states.
3. Extract/reuse House resolution without changing RentCharge generation semantics; add registration SMS/outbox transaction tests.
4. Define the named line-rendering input and D-5 job-selection/line-rendering tests. Preserve D-5 scheduler, grouping and idempotency.
5. Design the explicit BANK source contract, Bank envelope summary/provenance, child Payment identity, movement idempotency and migration/index compatibility. Complete duplicate preflight before any schema migration.
6. Implement Bank shared settlement only after the contract is approved; test advance credit, same-estate cross-tenancy allocation, full surplus, replay, fencing, abort and legacy repair.
7. Define and implement PayBill exact-reference validation and Till timestamp-based unique tenancy resolution; persist source attributedTenancyId and test zero/ambiguous/closed cases under the existing posting/link fences.
8. Build the receipt-envelope Payments read model with state eligibility, historical ownership, current-balance semantics, validated query inputs and index/query-plan proof.
9. Verify the separate frontend repository and implement/test mobile staff actions there.
10. Run focused suites, G3/G4 regressions and required replica-set integrations in an already provisioned disposable environment. Report any unavailable integrations as not run.


Each step should be independently reviewable. Do not combine schema migrations, payment posting enablement and UI changes into one unreviewable patch.

## 13. Verification boundaries

The audit was source-level. It did not execute production transactions, live SMS, live Daraja callbacks, production migrations or real Bank settlement. Do not describe these behaviours as runtime-proven.

Tests that require MongoDB replica-set transactions must use an existing disposable replica-set environment. If unavailable, report them as not run. No database server installation is authorized by this work.

## 14. Existing notification-document reconciliation

docs/G5_NOTIFICATIONS_PRD.md, docs/G5_NOTIFICATIONS_ARCHITECTURE.md and docs/G5_NOTIFICATIONS_SUMMARY.md remain the source for unaffected notification/link/outbox mechanics. Their statements that registration bill text comes only from existing RentCharge rows are superseded by docs/g5/audited-corrections/PRD.md PR-01 and Architecture §4. The correction uses the exact House configuration; it does not create charges. Those old statements must be synchronized in a dedicated documentation change before implementation merges.

Retain all unrelated notification requirements: server-side Estate name, one ordinary/protected welcome path, protected token encryption and versioning, stable resend/rotation/revocation, multi-tenancy link lifecycle, caller-owned Mongo transaction, outbox-only enqueue, post-commit provider dispatch, missing-phone behaviour, payment confirmations, Bank instruction restrictions, unknown-provider-result handling, and D-5 schedule/grouping/idempotency. D-5 is not superseded.

## 15. Implementation acceptance traceability

PRD §6.1 is the authoritative minimum test matrix. In particular:
- existing tests/unit/d5RentReminder.test.js proves template rendering/date utility behaviour only; it does not prove smsReminderJob selection;
- new registration resolver and message tests must prove source-specific effective dates, due-day fallback and transaction retry stability;
- Bank and M-PESA posting/replay/fence cases require replica-set integration tests;
- the Payments read model must be tested with posted, unallocated, unmatched, review, split and full-surplus source envelopes;
- frontend mobile acceptance must be proved in the independently verified frontend repository.

No source-level design statement in this document is runtime evidence. The source baseline, exact tests executed, environment and results must be recorded in the implementation PR/verification report.
