# G5 Collection and Rent-Lifecycle Corrections
**Status:** Audited target architecture; implementation not started  
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
- HOUSE_CONFIG currently selects configuration using the start of the requested month. Registration snapshot semantics require the configuration effective on registration day.
- HOUSE_TYPE plan versions are period-effective and must continue using their YYYY-MM version rules.
- The resolver has HouseType/billingPlanRev concurrency/write behaviour. A shared pure resolver extraction must not accidentally remove or bypass required write fencing.
- The registration transaction must pass its existing Mongo session through every read/write.
- Preserve explicit billingSource semantics; never fall through from HOUSE_TYPE to HOUSE_CONFIG or MONTHLY_RENT.
- Preserve LEGACY_UNCLASSIFIED fail-closed behaviour.

Recommended design: separate the shared source-resolution core from charge-generation side effects. Expose explicit resolution context (registration as-of date versus charge period) and keep all existing period-based charge generation semantics unchanged. Do not make registration invoke ensureChargesForHouse or generateChargesForEstate.

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

The current aggregate helper is suitable for numeric totals but not sufficient as the only rendering representation when distinct custom descriptions matter. Preserve individual charge lines for reminder text. Numeric summaries may still be grouped by charge type, but custom labels such as Security must remain visible and traceable to their RentCharge rows.

Reminder amounts must be derived from positive outstanding balances on the selected RentCharges, never from House plan amounts.

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

It does not establish that txn.transactionAt falls within tenancy.startAt/endAt. Add transaction-time coverage validation.

Do not blindly replace current status validation with date validation and auto-post every closed-tenancy receipt. A retired reference, closed tenancy, delayed callback and current posting policy interact. Preserve the receipt and evidence; when safe attribution is proven but automatic posting is not authorized, route to review rather than reassigning or posting by guess.

### 7.3 Till/link path

The Till evidence path validates the link/submission/merchant/mapping/receipt and timestamp agreement, but the exact tenancy date interval must also be loaded and checked before posting. The same interval invariant applies to PayBill and Till.

Keep existing posting lease/fencing, immutable attribution, merchant verification, receipt matching and transaction atomicity. Do not let a link rotation/revocation race create a second attribution path.

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

## 9. Staff mobile UI

The Staff page backend already has update/deactivate/activate operations with client scope and self-deactivation protection. The missing controls are in the mobile frontend card rendering.

Implementation belongs in the separate tycoon-frontend repository. Add the same permitted actions available in the desktop table to the mobile card layout, preserving responsive layout and existing action confirmation/feedback. Do not duplicate authorization rules in the frontend or add unnecessary backend endpoints.

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
| Closed tenancy callback arrives late | Validate transaction date and preserve attribution evidence; route unsafe automatic posting to review. |
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

1. Reconfirm exact source baseline and current branch diff before coding.
2. Extract/reuse House billing source resolution with explicit registration-date and charge-period contexts; add registration SMS tests.
3. Preserve D-5 selector and add line-description and Nairobi boundary tests.
4. Design Bank receipt identity/provenance and migration/index compatibility before changing settlement.
5. Route Bank settlement through settleTenantAccount with advance-credit, replay, concurrency and rollback tests.
6. Add M-PESA transaction-time tenancy coverage for PayBill and Till, including delayed historical receipt tests.
7. Build canonical receipt-level Payments read model and validated filters.
8. Update tycoon-frontend mobile staff actions in its own repository/workspace.
9. Run focused tests, existing G3/G4 regressions and replica-set integration tests where disposable infrastructure already exists.

Each step should be independently reviewable. Do not combine schema migrations, payment posting enablement and UI changes into one unreviewable patch.

## 13. Verification boundaries

The audit was source-level. It did not execute production transactions, live SMS, live Daraja callbacks, production migrations or real Bank settlement. Do not describe these behaviours as runtime-proven.

Tests that require MongoDB replica-set transactions must use an existing disposable replica-set environment. If unavailable, report them as not run. No database server installation is authorized by this work.
