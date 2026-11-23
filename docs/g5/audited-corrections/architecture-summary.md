# G5 Audited Corrections — Engineering Handoff

**Workspace branch:** docs/g5-audited-corrections-readiness  
**Base:** main at 2a291df091d35172f75b067acfca94179a3ebb36  
**Scope:** Registration House-plan snapshots, D-5 reminder line descriptions, Bank/M-PESA attribution and settlement, canonical receipt overview, and staff mobile actions.  
**Status:** Stress-tested requirements and target architecture recorded; no application code changed.

## Read order

1. This summary
2. PRD.md — product outcomes, locked business rules and testable acceptance matrix
3. architecture.md — source-level constraints, receipt contracts, concurrency/fencing, read model and implementation sequence

## Locked decisions

- Registration SMS is an informational snapshot of the exact House billing source. Never generate RentCharges for messaging and never infer invoice/Paid/Outstanding values.
- Capture one registrationAt instant before the retryable transaction; do not substitute moveInDate.
- HOUSE_CONFIG is timestamp-effective at registrationAt (inclusive start, exclusive end). Monthly RentCharge generation keeps period-start evaluation.
- HOUSE_TYPE version history remains period-effective. Registration uses the latest version effective for the registration YYYY-MM when history exists. For legacy HouseTypes with no version-history records, registration uses canonical `defaultBilling`; a future-only history is not bypassed. This does not invent effective dates or change charge generation.
- MONTHLY_RENT snapshots current House fields. Due day remains line → House → Estate default → day 5, with existing month-end clamping for generated due dates.
- Distinguish explicit UNCONFIGURED, unresolved legacy Houses, linked legacy HouseTypes resolved from `defaultBilling`, future-only plan history, and valid empty/zero plans.
- D-5 stays five Nairobi calendar days before saved RentCharge.dueDate. Scheduler stays daily 09:00 Nairobi; ordinary SMS dispatch stays independently every 60 seconds.
- Reminder text must preserve named selected-period RentCharge lines and their outstanding balances. Previous-period arrears remain a separate aggregate. No silent truncation.
- Receipt source Tenancy and allocation destination Tenancies are distinct. A verified receipt may settle older eligible obligations across tenancies within the same {clientId, estateId, tenantId} account; never cross estates.
- Bank must use an explicit BANK source contract in settleTenantAccount. Existing unique sparse Payment.bankTransactionId is not compatible with multiple receipt-origin child Payments. Design one child identity per destination Tenancy, Bank credit provenance, envelope summary and guarded migration before code.
- Bank date coverage uses BankTransaction.transactionDate, not valueDate. Source matched Tenancy is validated before estate-scoped shared allocation. Advance receipt with no charge becomes Tenant credit.
- PayBill pins an exact source Tenancy through its collection reference and copies it into canonical attributedTenancyId. Till's link/submission is tenant+estate scoped and does not identify a tenancy. Resolve by provider transaction timestamp and require exactly one interval-covering non-VOID historical tenancy; zero or multiple matches go to review. Both channels persist the same source attributedTenancyId field.
- Tenancy interval is half-open: startAt <= transactionAt < endAt; null end has no upper bound. Historical closed-tenancy receipts are review-only unless a separately approved G3 historical-posting policy says otherwise.
- Till acceptance proof from before link rotation/revocation remains valid for the submission identity, but does not bypass transaction-time tenancy validation.
- Payments overview contains one row for each confirmed/posted, tenant-attributed ManualReceipt, MpesaTransaction or BankTransaction. Unallocated/unmatched/review/debit rows stay in operational surfaces. Fully-surplus posted receipts remain visible with no fake Payment.
- CREDIT-origin Payment rows are account activity, not receipts. Receipt gross, receipt-applied money and new credit are separate from existing credit consumed.
- Receipt-level House/Estate comes from historical source attribution, not mutable Tenant current-house fields. Account position is current at query time unless a posting-time snapshot is added.
- Staff mobile correction stays in tycoon-frontend, but repository, commit, exact component and tests must be verified before claiming acceptance.

## Main source findings

- tenant.service.js queries current-period RentCharge rows for registration SMS.
- rent.service.js#planLinesForHouse is private; HouseBillingConfig uses timestamp intervals, HouseType plan versions use YYYY-MM periods, and current source resolution has a write/session fence.
- smsReminder.job.js computes Nairobi today + 5 and groups by Tenant/Tenancy/period/due day. smsBilling.js collapses OTHER descriptions; the current D-5 template has only fixed type totals.
- Manual and M-PESA call settleTenantAccount; its source discriminator currently handles MANUAL and otherwise assumes MPESA. Bank remains on ensureChargesForHouse plus accountingPostingService.
- Payment.bankTransactionId is unique sparse. BankTransaction has no multi-child settlement summary. TenantCreditMovement has M-PESA and Manual provenance, but no Bank provenance.
- PayBill references hold tenancyId; Till links and submissions do not. evaluateEvidence needs a separate timestamp-based tenancy resolver.
- paymentService.list unions non-child Payments and ManualReceipt envelopes; it does not yet provide a canonical posted Bank/M-PESA receipt envelope list.
- Backend staff API operations are present in the reviewed backend source; separate frontend mobile evidence remains pending verification.

## Critical design gates

1. Source-specific House effective-date resolution, missing-plan states, due-day fallback and stable registration timestamp must be specified in code contracts before resolver extraction.
2. BANK must become an explicit settlement source with receipt summary, child identity, credit provenance, claim replay and migration design. Do not remove the unique Bank Payment index speculatively.
3. Till must resolve exactly one historical tenancy at provider transaction time and persist that source attribution independently from allocation child tenancies.
4. Closed historical M-PESA receipts remain review-only without separate G3 authorization; no reference/link reassignment.
5. Payments read visibility is restricted to confirmed/posted tenant-attributed envelopes; distinguish gross receipt, receipt allocation, existing credit consumed, new credit earned and current account position.
6. Old notification documents' registration billing-source paragraphs are superseded by PR-01 and must be synchronized before implementation merge; all unaffected notification/link/outbox rules and D-5 remain.

## Test contract

PRD §6.1 is authoritative. The minimum matrix covers source-specific House snapshots, registration transaction retries/outbox paths, D-5 actual job selection (+4/+5/+6 Nairobi days), named line rendering, Bank source attribution/advance credit/split/full-surplus/replay/fencing/migration, PayBill and Till interval/ambiguity/closed cases, same-estate cross-tenancy allocation, receipt envelope visibility/accounting/query authorization, and frontend mobile actions.

The existing tests/unit/d5RentReminder.test.js checks template and Nairobi date utilities; it does not prove the reminder job's database selection. Replica-set posting/read-model tests require an already available disposable replica set. New test paths in PRD §6.1 are planned locations, not claimed existing tests.

## Explicitly out of scope

- Replacing D-5, changing dueDay, YYYY-MM, full-month eligibility or no-proration.
- A day-effective HouseType plan model or retroactive plan changes.
- A second settlement engine, wallet or mutable Tenant balance.
- Automatic historical M-PESA posting without separate G3 policy approval.
- Production provider calls, SMS sends, callback exposure, migrations or financial posting enablement.
- Editing frontend code before its exact repository baseline and component are verified.
- Mixing C2B merchant callback-readiness into this rent-lifecycle correction.

## Verification status

This is a source-level design/documentation revision, not a runtime acceptance report. No application tests were run; no application code, frontend code, production database, live SMS, Daraja provider or Bank provider was accessed. No migration was executed. The branch must be rechecked against current source before implementation.

## Next engineering order

House snapshot contract → registration/outbox tests → named D-5 line rendering and actual job-selection tests → BANK source/schema/migration design → Bank shared settlement → PayBill/Till source-tenancy attribution → canonical receipt read model → verified frontend mobile change → focused and replica-set verification.
