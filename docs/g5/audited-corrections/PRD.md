# G5 Collection and Rent-Lifecycle Corrections
**Status:** Audited requirements baseline; documentation only  
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
- HOUSE_TYPE: the effective HouseType plan version and its individual lines.
- HOUSE_CONFIG: the effective HouseBillingConfig rows for that House.
- MONTHLY_RENT: the House monthly rent and its due-day policy.
- UNCONFIGURED: explicitly report that no billing plan is configured.
- LEGACY_UNCLASSIFIED: fail closed and report that the plan cannot currently be determined; do not silently guess or fall back.

Preserve each line's description, charge type, amount and applicable due day. A Rent 20,000, Water 2,000 and Security 1,000 plan must not become Rent 20,000, Water 2,000 and Other 1,000.

The message is an informational House-plan snapshot. It is not proof that RentCharges were generated, an invoice was issued, money was paid or an amount is outstanding. Do not display Paid or Outstanding figures from configuration alone.

The snapshot must be scoped by clientId, estateId and houseId and must not use another tenant's historical charges.

Effective-date rule: the snapshot describes the configuration applicable on the registration date. Monthly charge generation continues to use the billing configuration effective for the target YYYY-MM period. The implementation must share the existing source-resolution rules rather than duplicate the mapping logic, while keeping these two evaluation dates explicit. A configuration created during a month must not be silently treated as effective from the first day of that month.

### PR-02: D-5 reminder remains five days early

Keep the existing D-5 selection rule. The job selects open positive-balance RentCharges whose saved dueDate falls exactly five Nairobi calendar days after the selection date. The daily selection schedule remains 09:00 Africa/Nairobi and ordinary SMS dispatch remains independent.

A due date of 17 December means the reminder is selected on 12 December, not on 17 December and not after the due date.

RentCharges remain authoritative for actual amounts owed. Do not derive reminder amounts from House configuration. Do not send settled charges or turn an ungenerated configured plan into a debt.

Preserve the current tenancy/period/due-date grouping and idempotency identity. Retain each RentCharge description in the message, including custom OTHER descriptions such as Security. Do not collapse distinct named lines into a generic Other total where the line identity is available.

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
- no over-allocation;
- any surplus recorded as immutable Tenant credit movements;
- conservation of gross receipt = amount allocated from receipt + new credit earned;
- transaction-safe idempotency and receipt provenance.

Do not create a second Bank allocator or use OVERPAID charge balances as a substitute for tenant credit.

Payment acceptance is governed by the transaction date and exact Tenancy coverage, not by whether the date equals the due date. A valid advance payment with no generated charge available must be retained as tenant credit, not rejected solely because the billing job has not generated the current period's RentCharge.

### PR-05: Bank settlement joins the shared accounting path

BankTransaction remains the canonical Bank receipt envelope and retains provider identity, transactionDate, valueDate, processing claim and reconciliation state.

The correction must stop requiring monthly charge generation as a prerequisite to accept a valid advance Bank receipt. It must route settlement through the shared tenant-credit service.

The design must resolve how one Bank receipt is represented when settlement creates multiple child Payment rows across tenancies or obligations. Current Bank Payment provenance/index constraints must be audited before changing schema or indexes. No speculative unique index or unsafe one-payment-per-receipt assumption is permitted.

Bank receipt provenance must be retained on all child payments and credit movements. Replays, concurrent workers, claim expiry and repair/retry paths must not create duplicate financial effects.

### PR-06: M-PESA transaction-time tenancy validation

For PayBill reference and Till/link attribution, validate the provider transaction timestamp against the exact Tenancy interval:
- transactionAt must be on or after the tenancy start;
- transactionAt must be before the tenancy end when an end exists, using the repository's established interval convention;
- client, estate, tenant, house and tenancy identities must agree with the evidence and canonical receipt;
- attribution remains immutable once claimed.

Do not equate current ACTIVE status with transaction-time validity. A receipt made while a tenancy covered the transaction date must not be silently reassigned because processing was delayed. The handling of closed-tenancy historical receipts must be explicit and safe: preserve evidence and route to review when the current reference or posting policy cannot safely authorize automatic posting.

A receipt outside the tenancy interval must not post to that tenancy. Till and PayBill paths must enforce the same coverage invariant without weakening their existing evidence, merchant mapping, receipt verification or fencing rules.

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

Do not claim that the credited tenant is necessarily the actual payer. M-PESA payer MSISDN/name is not currently a reliable substitute for the credited tenant identity. Do not count credit applications as newly received money. Preserve estate/client visibility filters.

### PR-08: Staff mobile actions

The Staff mobile card layout must expose the same permitted Edit and Activate/Deactivate actions available in the desktop table. Keep existing backend authorization, self-deactivation prohibition, client scoping and activation semantics. This is a frontend correction in the separate tycoon-frontend repository, not a reason to change backend staff APIs.

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

## 7. Release gates

Documentation approval is not implementation approval. Implementation must be split into reviewable slices, each with focused tests. Any schema/index change requires a separate migration design, duplicate preflight, guarded execution plan and rollback/recovery analysis. Financial integration tests require an already available disposable MongoDB replica set. If it is unavailable, report them as not run; do not install a database server merely to make the test report green.

## 8. Relationship to existing documentation

This folder is the canonical requirements record for the audited corrections above. Existing G5 notification documents remain useful for unaffected SMS, protected-link and outbox behaviour, but their registration billing-source wording is stale for this correction and must be reconciled before implementation. The D-5 timing requirement in those documents is correct and remains in force.

The separate C2B merchant-registration/callback-readiness workspace is not merged into this correction scope. Merchant collection readiness, receipt trust and G3 financial posting remain distinct gates.
