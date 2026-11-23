# G5 Audited Corrections — Engineering Handoff

**Workspace branch:** docs/g5-audited-corrections-readiness  
**Base:** main at 2a291df091d35172f75b067acfca94179a3ebb36  
**Scope:** Documentation for the audited registration billing, D-5 reminder, Bank/M-PESA settlement, Payments overview and staff mobile corrections.  
**Status:** Requirements and target architecture recorded; no application code changed.

## Read order

1. This summary
2. PRD.md — product outcomes, business rules and acceptance criteria
3. architecture.md — source findings, data flow, invariants, risks and implementation sequence

## Locked decisions

- Registration SMS describes the billing plan configured on the exact House. It must not depend on RentCharges existing for a brand-new tenancy.
- Registration plan lines retain descriptions such as Rent, Water and Security. The message is informational; it does not claim an invoice, Paid amount or Outstanding balance.
- Registration snapshot uses configuration effective on registration date. Monthly charge generation continues to use the existing YYYY-MM period-effective rules.
- D-5 stays D-5. A charge due on the 17th is selected on the 12th in Africa/Nairobi.
- Reminders use actual positive outstanding RentCharge balances and saved dueDate, not configured House plan amounts.
- Preserve YYYY-MM, Africa/Nairobi, full-calendar-month eligibility and no-proration behaviour.
- Manual, Bank and M-PESA must converge on shared settleTenantAccount policy. Bank must not reject a valid advance receipt just because no current RentCharge has been generated.
- Validate M-PESA transactionAt against the exact Tenancy interval for both PayBill and Till paths. Delayed valid receipts must not be reassigned; unsafe historical cases go to review.
- Payments overview is one row per canonical receipt envelope, including receipts whose full value becomes Tenant credit. Show gross receipt, allocations and credit separately.
- Staff mobile cards must expose existing Edit and Activate/Deactivate actions. This frontend work belongs in tycoon-frontend.

## Main source findings

- tenant.service.js currently queries current-period RentCharge rows for registration SMS.
- rent.service.js already has the private planLinesForHouse resolver for HOUSE_TYPE, HOUSE_CONFIG, MONTHLY_RENT, UNCONFIGURED and LEGACY_UNCLASSIFIED.
- smsReminder.job.js already computes Nairobi today + 5 days and selects saved dueDate rows. Fix labels, not timing.
- Manual and M-PESA use tenantCredit.service.js settleTenantAccount; Bank still calls ensureChargesForHouse and the older accountingPostingService path.
- PayBill reference evidence checks exact identity and ACTIVE status but not transaction-time interval coverage; Till needs the same exact interval check.
- Payments list combines non-child Payment rows and ManualReceipt envelopes, but is not consistently canonical across M-PESA and Bank.
- Backend staff actions exist; the missing mobile actions are a frontend presentation gap.

## Critical design gates

1. Extract/reuse the House plan resolver without changing billing-period behaviour or bypassing HouseType concurrency/write semantics.
2. Define Bank receipt-to-many-Payment provenance and TenantCreditMovement source identity before altering unique indexes.
3. Distinguish transaction-time tenancy coverage from current tenancy status and define review handling for delayed historical receipts.
4. Keep canonical receipt listing independent of whether child Payment rows exist.
5. Preserve estate/client filtering and never confuse credited tenant with actual payer.

## Explicitly out of scope

- Replacing D-5 or changing dueDay.
- Changing YYYY-MM, monthly charge eligibility or proration.
- New accounting engine, wallet or mutable balance.
- Production SMS/provider calls, callback exposure, migrations or posting enablement.
- Mixing the separate C2B merchant callback-readiness workspace into these rent-lifecycle corrections.

## Verification status

This is a source audit and documentation baseline, not a runtime acceptance report. No application tests were run as part of this documentation commit. No production database, SMS, Daraja or Bank provider was accessed. Replica-set integration tests remain required before financial implementation and must use an existing disposable environment.

## Next engineering order

Registration plan resolver and SMS → D-5 line descriptions/tests → Bank receipt identity design → Bank shared settlement → M-PESA tenancy interval checks → canonical Payments read model → separate frontend mobile staff action fix.
