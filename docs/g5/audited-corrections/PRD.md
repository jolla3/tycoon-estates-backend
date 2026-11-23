# G5 Collection and Rent-Lifecycle Corrections
**Status:** Stress-tested requirements baseline; design decisions expanded; documentation only  
**Repository:** jolla3/tycoon-estates-backend  
**Baseline:** main at 2a291df091d35172f75b067acfca94179a3ebb36  
**Workspace:** docs/g5-audited-corrections-readiness

## 1. Product outcome

Tycoon Estates must present the correct House billing plan at tenant registration, remind tenants before rent is due, accept and settle valid receipts consistently across Manual, Bank and M-PESA channels, and show each received receipt accurately in the Payments overview.

This is a correction to existing rent, tenancy, receipt and notification paths. It is not a new billing engine, wallet, rent-cycle model or payment subsystem.

## 2. Problem statement

The audit found several connected defects that are currently documented and implemented in separate areas:

1. Registration SMS reads generated RentCharge rows even though the newly created tenancy may not have generated charges yet. The tenant is being assigned to a House whose billing configuration is already the intended source for the configured monthly lines.
2. The D-5 reminder selection is already conceptually correct, but its charge aggregation can hide custom descriptions such as Security under a generic Other label.
3. Bank settlement still follows an older allocation path and may require charge generation for the current period. This is inconsistent with the shared tenant-credit settlement used by Manual and M-PESA.
4. M-PESA attribution does not consistently verify that the provider transaction timestamp falls within the exact tenancy interval. Current tenancy status must not be used as a substitute for transaction-time coverage.
5. The general Payments overview does not represent every provider receipt as one canonical receipt row, especially when an M-PESA receipt is entirely surplus credit or splits across multiple obligations.
6. Staff Edit and Deactivate actions are missing from the mobile card layout in the frontend.

These are related through the rent lifecycle, but they are not one undifferentiated feature. The implementation must keep configuration, generated obligations, received money, allocations and tenant credit distinct.

## 3. Goals

- Show a new tenant the House's configured recurring billing lines and amounts in the registration SMS, with original descriptions retained.
- Preserve D-5 reminders: if a saved RentCharge is due on the 17th, its reminder is selected on the 12th in Africa/Nairobi.
- Base reminders on actual outstanding RentCharge balances, not on the configured plan alone.
- Accept a Bank or M-PESA receipt when its transaction date is covered by the exact attributed tenancy, even if payment is made before the due date or before a monthly RentCharge exists.
- Use the shared tenant-account settlement and credit rules consistently across Manual, Bank and M-PESA.
- Present one canonical receipt in Payments, with a transparent breakdown of applied money, credit consumed and credit earned.
- Preserve mobile staff management actions without changing their backend authorization rules.

## 4. Non-goals

- No change to calendar-month billing periods, YYYY-MM period identity, full-calendar-month charge eligibility or no-proration policy.
- No change to the five-day reminder lead time, reminder schedule, SMS provider, sender ID or dispatch cadence.
- No new billing engine, second allocator, wallet, tenant balance field or parallel credit ledger.
- No acceptance of a payment merely because the tenant currently points to a House; exact tenant, House, estate and Tenancy ownership must still be verified.
- No fabricated bank instructions, invoice status, paid amount, outstanding amount or payer identity.
- No production Daraja/Safaricom calls, production callback exposure, production posting enablement, live SMS sends or production database changes.
- No unrelated frontend redesign.

## 5. Product requirements

### PR-01: Registration billing snapshot uses House configuration

At tenant registration, resolve the billing plan belonging to the exact House being assigned to the tenant, within the existing client and estate scope.

Supported House billing sources remain:
- HOUSE_TYPE: the latest HouseTypePlanVersion effective for the registration YYYY-MM, when version history exists. For a legacy HouseType with no version-history records at all, use its canonical `HouseType.defaultBilling` lines for the registration snapshot only. Do not infer or backfill a historical effective period, and do not use the legacy `defaultRentCents` mirror as a substitute.
- HOUSE_CONFIG: the effective HouseBillingConfig rows for that House.
- MONTHLY_RENT: the House monthly rent and its due-day policy.
- UNCONFIGURED: explicitly report that no billing plan is configured.
- LEGACY_UNCLASSIFIED: for registration only, a non-null `houseTypeId` is an explicit source relationship and resolves through that exact client/estate-owned HouseType. Without that relationship, fail closed; do not guess another source.

Preserve each line's description, charge type, amount and applicable due day. A Rent 20,000, Water 2,000 and Security 1,000 plan must not become Rent 20,000, Water 2,000 and Other 1,000.

The message is an informational House-plan snapshot. It is not proof that RentCharges were generated, an invoice was issued, money was paid or an amount is outstanding. Do not display Paid or Outstanding figures from configuration alone.

The snapshot must be scoped by clientId, estateId and houseId and must not use another tenant's historical charges.

Effective-date and due-day rules are source-specific; do not pretend every source has the same clock:

- Capture one registrationAt instant for the registration operation before entering the retryable MongoDB transaction. Reuse it on transaction callback retries. It is the registration event time, not moveInDate or a future tenancy start date.
- HOUSE_CONFIG is timestamp-effective. Resolve rows whose effective interval covers registrationAt, with an inclusive effectiveFrom and exclusive effectiveTo boundary, while preserving the existing service's active/retired-row semantics. A row added after registrationAt must not appear in that snapshot. Monthly RentCharge generation continues to evaluate the configuration at the target period's start under the current resolver.
- HOUSE_TYPE is period-effective, not day-effective: when version history exists, HouseTypePlanVersion stores only effectiveFromPeriod (YYYY-MM). Resolve the latest version whose period is less than or equal to the registration period. Under current semantics, a version appended during a month can apply to that whole period. If the HouseType has no version-history records at all, registration uses its canonical current `defaultBilling` lines without inventing an effectiveFromPeriod; this compatibility fallback is registration-only and does not backfill charge-generation history. If history exists but all versions are future-effective, no current plan applies. Do not describe plan versions as effective from their creation timestamps.
- MONTHLY_RENT is a current House snapshot of monthlyRent; it has no independent effective-dated history in the audited model.
- A configured source with no applicable plan is not the same state as explicit UNCONFIGURED. For HOUSE_TYPE, no version-history records means use the linked type's `defaultBilling`; existing history with only future-effective versions means no current plan applies. A valid empty `defaultBilling` or version `lines` array is different from missing history. For HOUSE_CONFIG, do not invent an empty plan: HouseBillingConfig is stored as individual line rows and has no parent plan record. No effective rows therefore means no effective House config; query future-dated rows to distinguish future-only configuration. A zero-amount row is a configured zero line. MONTHLY_RENT with a zero amount is still the selected billing source.
- Resolve each line's due day using the existing fallback: line dueDay, then House.dueDay, then Estate.defaultDueDay, then day 5. Month-end clamping remains unchanged. The snapshot may describe the configured due-day policy, but it must not claim an actual RentCharge due date exists.
- Share the source-resolution rules, but keep registrationAt resolution separate from period-based charge generation. Do not remove HouseType billingPlanRev write fencing or the caller's Mongo session.


### PR-02: D-5 reminder remains five days early

Keep the existing D-5 selection rule. The job selects open positive-balance RentCharges whose saved dueDate falls exactly five Nairobi calendar days after the selection date. The daily selection schedule remains 09:00 Africa/Nairobi and ordinary SMS dispatch remains independent.

A due date of 17 December means the reminder is selected on 12 December, not on 17 December and not after the due date.

RentCharges remain authoritative for actual amounts owed. Do not derive reminder amounts from House configuration. Do not send settled charges or turn an ungenerated configured plan into a debt.

Preserve the current tenancy/period/due-date grouping and idempotency identity. The rendering input must retain a line-level entry for every selected-period RentCharge: description, chargeType, and that line's positive balanceCents. Render the named line and its outstanding amount, including custom OTHER descriptions such as Security. A type-only Other aggregate is not an acceptable replacement when the original description exists.

Use a deterministic order (the existing charge-type priority, then normalized description, then stable charge ID). Do not merge separate named lines merely because they share chargeType. Previous-period arrears remain a separate aggregate under the existing reminder policy; this correction does not claim to reconstruct or relabel every historical arrears line.

Render all selected lines and their values. Do not silently truncate, omit, or round financial lines to fit an SMS. If the complete message exceeds an enforced provider/queue limit, fail the queue operation visibly and record the operational reason; do not send a misleading partial statement. Adding a new multi-message splitting policy is not part of this correction.


### PR-03: Preserve the existing rent calendar

- Period identity remains YYYY-MM.
- All business-date interpretation remains Africa/Nairobi.
- Monthly charge generation continues to require the existing full-calendar-month tenancy eligibility.
- Partial-month rent is not prorated by this correction.
- Due dates continue to come from saved RentCharge dueDate for reminders.
- Existing HouseType plan versions, HouseBillingConfig effective dates, due-day fallback and month-end clamping must not be casually changed.

### PR-04: Consistent receipt settlement

Manual, Bank and M-PESA receipts must use the shared tenant-account settlement policy, including:
- exact tenant/client/estate/tenancy validation;
- existing tenant credit applied before new receipt money where the shared policy requires it;
- oldest eligible obligations first;
- charge-type ordering already defined by the shared planner;
- allocation may span eligible tenancies belonging to the same {clientId, estateId, tenantId} account, including historical closed tenancies; it must not cross the estate-scoped credit account;
- the exact tenancy that validates receipt attribution is not required to be the tenancy of every allocation destination;
- no over-allocation;
- any surplus recorded as immutable Tenant credit movements;
- conservation of gross receipt = amount allocated from receipt + new credit earned;
- transaction-safe idempotency and receipt provenance.

Do not create a second Bank allocator or use OVERPAID charge balances as a substitute for tenant credit.

Payment acceptance is governed by the provider/receipt transaction timestamp and the exact source Tenancy coverage, not by whether the date equals the due date or by the processing date. Bank uses BankTransaction.transactionDate, not valueDate; M-PESA uses canonical MpesaTransaction.transactionAt. The source Tenancy proves where/when the receipt is attributable. The shared allocator may then apply funds to older eligible obligations across other tenancies in the same estate-scoped tenant account. Do not force every allocation to the source Tenancy.

A valid advance payment with no generated charge available must be retained as tenant credit, not rejected solely because the billing job has not generated the current period's RentCharge. A receipt attributed to one estate must not consume credit or obligations in another estate.


### PR-05: Bank settlement joins the shared accounting path

BankTransaction remains the canonical Bank receipt envelope and retains provider identity, transactionDate, valueDate, processing claim and reconciliation state.

The correction must stop requiring monthly charge generation as a prerequisite to accept a valid advance Bank receipt. It must route settlement through the shared tenant-credit service.

The design must resolve how one Bank receipt is represented when settlement creates multiple child Payment rows across tenancies or obligations. Current Bank Payment provenance/index constraints must be audited before changing schema or indexes. No speculative unique index or unsafe one-payment-per-receipt assumption is permitted.

Bank receipt provenance must be retained on all child payments and credit movements. Replays, concurrent workers, claim expiry and repair/retry paths must not create duplicate financial effects.
Required Bank settlement contract:

- The shared settlement service must accept an explicit BANK receipt source; it must not infer every non-MANUAL source to be M-PESA. The receipt identity is the internal BankTransaction._id, backed by immutable {provider, providerTransactionId} uniqueness.
- BankTransaction.matchedTenancyId, matchedTenantId, matchedHouseId, clientId and estateId identify the source attribution context. Revalidate that exact Tenancy covers transactionDate and belongs to those exact identities before settlement. Do not use the tenant's mutable current House pointer.
- Receipt-origin child Payment rows may be one-to-many, grouped by allocation destination Tenancy. The existing unique sparse Payment.bankTransactionId constraint cannot remain as-is if the same Bank receipt is linked to multiple receipt-origin children. The target schema must define one child identity per {BankTransaction, allocation Tenancy} (or an equally strong deterministic child key) and prove it with duplicate preflight and dependent-query review. Do not weaken/remove the existing index without that design and a guarded migration.
- TenantCreditMovement needs Bank receipt provenance. Record the triggering receipt identity on surplus and credit-application movements using semantics consistent with the existing M-PESA/manual paths. A credit-application movement still represents consumption of pre-existing credit, not money from the Bank receipt.
- The Bank envelope must persist or deterministically reconstruct receipt-origin paymentIds, credit-application creditPaymentIds, creditMovementIds, receiptAppliedCents, creditAppliedCents, and newCreditCents. A fully-surplus Bank receipt must remain visible and idempotent even with no child Payment.
- The existing Bank processing claim token/expiry remains the ownership fence. Claim acquisition, shared settlement writes and the final POSTED summary update must be atomic in the same MongoDB transaction, with the final update conditional on the still-valid token. A retry after a committed result returns the recorded result; an expired/lost claim cannot commit a second financial effect.
- Legacy Bank rows must be reconciled before migration. Do not automatically convert historical OVERPAID charge balances or unapplied Bank amounts into credit without an auditable, separately approved repair plan.


### PR-06: M-PESA transaction-time tenancy validation

For PayBill reference and Till/link attribution, validate the provider transactionAt against one exact source Tenancy using the repository's half-open interval: startAt <= transactionAt < endAt; a null endAt has no upper bound. VOID tenancies are not candidates. Reject invalid timestamps and preserve exact client, estate, tenant, house and tenancy ownership.

PayBill resolution: the active/retired MpesaCollectionReference already pins one tenancyId. Verify that exact Tenancy and its interval. A retired reference or closed Tenancy is not silently reactivated or reassigned. Preserve the canonical receipt and reference evidence, and route unsafe historical cases to review.

Till/link resolution: the current MpesaSubmissionLink and MpesaSmsSubmission are tenant+estate scoped, not tenancy- or house-scoped. Do not pretend a tenancy can be read from the link. Resolve all non-VOID tenancies for that exact {clientId, estateId, tenantId} whose half-open interval covers txn.transactionAt. Exactly one candidate is required. Zero candidates or multiple candidates (including overlapping historical data) go to review; never choose the newest, current or nearest tenancy by guess. On successful attribution, persist the canonical source attributedTenancyId on MpesaTransaction for both channels under the receipt's existing conditional claim/posting fence: PayBill copies the immutable reference.tenancyId; Till stores its unique timestamp-resolved tenancy. The source House is derived from that exact Tenancy.

Do not equate current ACTIVE status with transaction-time validity. A transaction made during an interval but processed after that Tenancy closes is historically attributable, but must go to review unless a separate, explicitly approved G3 historical-posting policy authorizes automatic posting. This correction does not introduce that authorization.

A receipt outside the source Tenancy interval must not post to it. Till and PayBill enforce the same interval invariant while preserving their different identity evidence. A Till submission accepted before link rotation/revocation retains its existing acceptance proof, but that proof does not bypass tenancy-time validation. Preserve receipt verification, merchant mapping, first-valid attribution, immutable claims and posting/link fencing.

### PR-07: Canonical Payments overview

The Payments overview must represent one row per canonical received-money receipt, not one row per allocation child and not omit a receipt because all its value became tenant credit.

Canonical source envelopes include ManualReceipt, MpesaTransaction and BankTransaction. The list must join child Payments, PaymentAllocations and TenantCreditMovements to explain settlement.

Where available, show:
- gross amount received;
- credited tenant/account holder;
- House and Estate;
- receipt/payment date and source;
- tender/provider method and external reference;
- amount applied from this receipt;
- existing tenant credit consumed, shown separately from new money;
- new tenant credit earned;
- allocation breakdown and remaining account position.

Do not claim that the credited tenant is necessarily the actual payer. M-PESA payer MSISDN/name is not currently a reliable substitute for the credited tenant identity. Do not count credit applications as newly received money. Preserve estate/client visibility filters and historical receipt ownership.

The receipt list includes only confirmed/posted, tenant-attributed incoming-money envelopes: confirmed ManualReceipt; MpesaTransaction with postingState=POSTED and exact attributed tenant/estate; and BankTransaction with processingState=POSTED and verified matched tenant/tenancy/estate context. Unallocated/unmatched M-PESA and Bank records, debit transactions, and receipts in review/failed/processing states remain in their operational review/reconciliation surfaces; they must not be exposed as tenant receipts or guessed into an estate. Fully-surplus posted receipts are included even with zero receipt-origin Payment children.

A CREDIT Payment is an application of existing credit, not a receipt row. Expose it in allocation/account activity detail where useful, but never as another received-money receipt. receiptAppliedCents is the sum of receipt-origin allocations; creditAppliedCents is existing credit consumed during that settlement operation; newCreditCents is the surplus created from the new receipt. The two conservation equations are independently enforced:
- gross receipt = receipt-origin amount applied + new credit earned;
- credit before = existing credit applied + credit remaining.

The House displayed at the receipt level is the historical source/attribution House (from the source Tenancy or manual receipt envelope). Allocation details may show different destination Houses/Tenancies where cross-tenancy settlement applies. Never rewrite historical receipt ownership from the Tenant's current House pointer.

Label the account balance as the tenant's current estate-scoped account position at query time. Do not present it as the historical balance immediately after the receipt unless a separate immutable posting-time snapshot is added. Stable pagination sorts by normalized receipt time descending and envelope ID as a tie-breaker. Validate every supplied ObjectId/date/filter before constructing aggregation stages; malformed filters must return a controlled validation error, not a cast exception. Profile bounded, indexed queries and enforce client/estate authorization in every source branch before unioning results.


### PR-08: Staff mobile actions

The Staff mobile card layout must expose the same permitted Edit and Activate/Deactivate actions available in the desktop table. Keep existing backend authorization, self-deactivation prohibition, client scoping and activation semantics. This is a frontend correction in the separate tycoon-frontend repository, not a reason to change backend staff APIs.

Evidence boundary: the backend review confirms the staff API operations described in the source audit, but this documentation pass did not retrieve or verify the separate frontend repository, its branch, exact mobile-card component path or current UI test harness. Treat the missing-mobile-controls finding as an external source finding pending that repository/commit verification. Do not mark PR-08 accepted solely from backend evidence.


## 6. Acceptance criteria

1. Registration SMS shows the exact House plan lines and amounts for HOUSE_TYPE, HOUSE_CONFIG and MONTHLY_RENT sources.
2. Registration snapshot uses registration-date effective configuration and does not generate RentCharges.
3. UNCONFIGURED and LEGACY_UNCLASSIFIED cases are explicit and do not fabricate amounts.
4. A custom Security line remains Security in registration SMS and D-5 reminder output.
5. A charge due on the 17th is selected on the 12th in Nairobi; no change to D-5 timing or scheduler.
6. Reminder output is based only on open positive RentCharge balances and excludes settled charges.
7. Existing YYYY-MM and full-calendar-month generation tests remain unchanged and pass.
8. Valid Bank advance receipts inside tenancy coverage settle or become credit without requiring RentCharge generation.
9. Bank settlement uses shared credit-first/oldest-first allocation and preserves receipt provenance and replay safety.
10. PayBill and Till receipts are rejected or reviewed when transactionAt is outside the exact Tenancy interval; delayed valid historical receipts are not reassigned.
11. One canonical Bank, Manual or M-PESA receipt appears once in Payments, including a fully-surplus receipt.
12. Receipt totals, child allocations and credit movements reconcile without counting credit application as new money.
13. Payments list respects client and estate filters.
14. Staff mobile cards expose permitted Edit and Activate/Deactivate actions.
15. No production provider call, SMS send, migration execution or production financial posting is needed to prove these corrections.

### 6.1 Authoritative testable verification matrix

The numbered criteria above state product outcomes. The following cases define the minimum proof required to mark those outcomes accepted. New test paths below are proposed locations, not claims that those tests already exist.

| Area | Minimum deterministic test cases | Test level / proof |
|---|---|---|
| Registration / HOUSE_CONFIG | Config effective immediately before registrationAt is included; config starting after it is excluded; effectiveTo == registrationAt is excluded; missing effective rows are reported as no effective plan, not UNCONFIGURED; custom description, zero amount and due-day fallback are preserved. | Unit tests for resolver core plus transaction-backed registration/outbox test. |
| Registration / HOUSE_TYPE | Latest effectiveFromPeriod <= registration period is selected; a future-period version is excluded; a current-period version follows the existing period-level rule even when appended mid-month; no applicable version is reported distinctly; billingPlanRev conflict/retry and session propagation remain intact. | Unit/service tests plus transaction-backed registration test. |
| Registration / timing | Snapshot uses the captured registration event time, not a future moveInDate; transaction callback retry reuses the same captured instant; no RentCharge is generated; no invoice/Paid/Outstanding values are derived from configuration. | Service/replica-set integration test with a frozen clock. |
| Registration / messages | All named lines and due-day policies appear; UNCONFIGURED, LEGACY_UNCLASSIFIED, no-effective-plan and valid empty-plan states have distinct text; exactly one ordinary or protected welcome path is queued; missing phone does not block registration; no external SMS provider call occurs inside the transaction. | SMS snapshot unit tests and transaction/outbox integration test. |
| D-5 selection | A charge due at Nairobi day +4 is not selected, +5 is selected, +6 is not; selection at Nairobi midnight and month/year boundaries is correct; due date 17 selects on 12; settled/zero-balance rows are excluded; grouping/idempotency remains tenant+tenancy+period+due-day. | Job-selection tests; existing tests/unit/d5RentReminder.test.js is template/date utility coverage only and does not prove job selection. |
| D-5 line rendering | Two distinct OTHER descriptions remain separately named with their own positive balances; partial payment changes the displayed balance, not the configured amount; deterministic ordering is stable; prior-period arrears remain a separate aggregate; over-limit content is not silently truncated or queued as a partial financial message. | Template/renderer unit tests and queue validation test. |
| Bank source attribution | transactionDate (not valueDate) falls within exact matched Tenancy; tenant, House, client and estate mismatch fails closed; future/advance transaction with no RentCharge is retained as credit. | Pure attribution tests plus replica-set integration test. |
| Bank shared settlement | Explicit BANK source creates correct receipt-origin child Payments; one receipt split across multiple destination tenancies creates one correctly linked child per destination; full-surplus receipt creates no fake Payment but persists Bank-linked credit movement and receipt summary. | Shared-service unit/contract tests and replica-set integration tests. |
| Bank replay/fencing | Same receipt replay returns the same persisted summary; concurrent claimant cannot double-post; expired/lost token cannot finalize; aborted transaction leaves no financial writes; retry after a committed-but-unacknowledged result does not duplicate allocations or movements. | Replica-set integration tests against a disposable database. |
| Bank migration | Duplicate preflight covers legacy Bank Payment.bankTransactionId values and candidate compound child identity; legacy rows reconcile to Bank envelopes; old queries/idempotency readers are tested; rollback/recovery is documented before any index transition. | Migration preflight tests on fixtures and reviewed dry-run output; no production execution. |
| M-PESA PayBill | Exact reference Tenancy is checked with start-inclusive/end-exclusive boundary; closed/retired reference remains review-only; wrong scope and out-of-interval receipts never post. | Evidence unit tests plus replica-set posting/fence tests. |
| M-PESA Till | Tenant+estate link resolves all ACTIVE/CLOSED, non-VOID tenancies at provider transactionAt; exactly one match is required; zero and multiple matches go to review; resolved source tenancy is persisted once; accepted-before-rotation proof does not bypass date validation. | Pure resolver/evidence tests plus replica-set attribution/fence tests. |
| Receipt versus allocation Tenancy | A receipt attributed to a valid source Tenancy can settle older eligible obligations in other tenancies of the same estate; it cannot consume another estate's credit or obligations. | Shared allocator/settlement integration test with multiple tenancies and a second estate. |
| Payments read model | Each confirmed/posted envelope appears once; fully-surplus Bank/M-PESA appears without child Payment; split receipt still appears once; CREDIT child rows do not appear as new receipts; unallocated/review/unmatched/debit rows are not exposed as tenant receipts. | Read-model integration tests with fixtures for all envelope and state types. |
| Payments accounting | Receipt gross = receipt-applied + new credit; credit-before = credit-applied + credit-remaining; displayed current account position is explicitly current; source House and historical estate are not taken from a mutable current House pointer. | Read-model/settlement integration tests. |
| Payments authorization/query | Client boundary, estate-restricted staff, owner estate filter, historical estate ownership, malformed IDs/dates, stable sort and pagination are tested. | Controller/service integration tests; forbidden cross-estate fixtures must return no data. |
| Staff mobile actions | Desktop and mobile controls expose identical permitted actions; unauthorized, self-deactivation and cross-client actions remain blocked; mobile breakpoint rendering is tested in the frontend repository. | Frontend component/interaction tests after repository and baseline are verified. |

Required minimum planned test locations (create only where absent): tests/unit/g5/registrationHousePlanSnapshot.test.js, tests/unit/g5/rentReminderLineRendering.test.js, tests/unit/g5/mpesaTenancyAttribution.test.js, tests/integration/g5/bankSharedSettlement.integration.test.js, tests/integration/g5/mpesaTenancyPosting.integration.test.js, and tests/integration/g5/paymentReceiptReadModel.integration.test.js. Exact naming may follow repository conventions, but each scenario above must remain traceable to a test. Replica-set tests require an already available disposable MongoDB replica set; if unavailable they are reported as not run, never inferred as passed.

## 7. Release gates

Documentation approval is not implementation approval. Implementation must be split into reviewable slices, each with focused tests. Any schema/index change requires a separate migration design, duplicate preflight, guarded execution plan and rollback/recovery analysis. Financial integration tests require an already available disposable MongoDB replica set. If it is unavailable, report them as not run; do not install a database server merely to make the test report green.

## 8. Relationship to existing documentation

This folder is the canonical requirements record for the audited corrections above. It explicitly supersedes only these older notification statements:
- registration SMS billing text must be derived only from already-generated RentCharge rows;
- registration plan details are unavailable whenever current-period RentCharge rows do not yet exist.

Those statements are replaced by PR-01: registration describes the exact House billing configuration under the source-specific effective-date rules above, without generating RentCharges or claiming an invoice/paid/outstanding balance.

The following existing notification requirements remain in force and must be preserved: server-resolved Estate name; exactly one ordinary/protected welcome path; protected M-PESA link identity, encryption, rotation/revocation and acceptance proof; caller-owned registration transaction; queued outbox only (no provider call inside the transaction); post-commit dispatch; optional phone; bank-instruction restrictions; link multi-tenancy lifecycle; payment confirmation ownership; unknown provider outcome handling; and the full D-5 selection/grouping/idempotency/scheduling/dispatch contract. The D-5 timing language in the older docs is correct. Their files are not edited by this correction commit; a dedicated documentation synchronization must reconcile the superseded registration wording before implementation merges.

The separate C2B merchant-registration/callback-readiness workspace is not merged into this correction scope. Merchant collection readiness, receipt trust and G3 financial posting remain distinct gates.


The separate C2B merchant-registration/callback-readiness workspace is not merged into this correction scope. Merchant collection readiness, receipt trust and G3 financial posting remain distinct gates.
