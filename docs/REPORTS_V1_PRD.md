# Reports V1 — Backend Product Requirements

**Status:** Owner-approved scope translated into backend requirements, 26 November 2026  
**Repository:** jolla3/tycoon-estates-backend  
**Documentation branch:** docs/reports-v1-20261126  
**Base:** main @ a05b89830ca68608d473241a28fa6ea9f73e9923  
**Document boundary:** Cross-domain read/reporting contract for existing G3, G4 and G5 data. This does not expand the G4 Banking product scope, change the G5 collection product, or create another accounting engine.

## 1. Product outcome

Expose trustworthy, client-scoped and estate-scoped aggregates for the approved Reports V1 UI: Overview, Revenue & Collections, Arrears, Occupancy and M-PESA Collections. Reports are read-only projections of existing domain records. The backend remains the sole owner of financial rules, receipt identity, tenancy attribution, provider verification and authorization.

## 2. Scope

### Required

1. Extend the existing management report summary with clearly defined portfolio, charge, allocation and occupancy metrics.
2. Provide a paginated arrears list with exact tenancy identity and saved due-date semantics.
3. Provide receipt-level cash collection measures without double-counting child Payments created from one receipt.
4. Reuse the existing canonical M-PESA receipt summary endpoint and its metric definitions.
5. Add a bounded, count-only M-PESA SMS-submission state summary.
6. Enforce client identity, estate scope and product entitlement on the server.
7. Preserve null/unverified values and explicit coverage information.

### Excluded from V1

Expenses, profit-and-loss, cash-flow statements, budgets, forecasts, advanced arrears aging buckets, custom date ranges, exports, detailed Banking reporting and SMS delivery analytics. No new financial collections, ledger, posting, matching or allocation write path is permitted.

## 3. Existing API contracts to reuse

- GET /reports/management?period=YYYY-MM&estateId={optional}. This is the existing management summary route. The selected estate is passed through clientContext into req.estateFilter; the service must use that enforced scope. The response must not embed an unbounded arrears detail array.
- GET /mpesa-transactions/summary?startDate={ISO}&endDate={ISO}&estateId={optional}. This route and the mpesaReceiptSummary reducer already exist. It is bounded to 93 days and returns providerObserved, mutually exclusive states, verification, posted and byEstate.
- GET /mpesa-transactions remains canonical receipt history, not a G3 Payment report.
- Existing tenant account/credit services remain authoritative for Tenant+Estate account credit. No second credit balance is introduced.

## 4. Required backend addition: SMS submission summary

Add GET /mpesa-collection/submissions/summary.

**Authorization and scope**
- Reuse the existing authenticated mpesaCollection route middleware: authenticate, clientContext and requireProduct('MPESA').
- Keep the existing administrative/report-view role policy consistent with the current submission review list; do not add a global bypass.
- Accept an optional estateId only through query validation and clientContext. Every query must include clientId and estateFilterClause(req.estateFilter).
- A restricted estate user must not aggregate another estate's evidence. A client-wide authorized reviewer may see all submissions within that explicit client.
- No evidenceEnvelope, raw SMS text, digest, key ID, parser internals or payer details are returned.

**Window and response**
- Require startDate and endDate as valid ISO instants with startDate <= endDate. Bound the window to at most 93 days, matching the canonical M-PESA receipt summary.
- Filter by MpesaSmsSubmission.createdAt (submission-received time), not smsTransactionAt. The response must identify the window and its date meaning.
- Return counts by every declared SUBMISSION_STATE: RECEIVED, UNSUPPORTED, PARSED, UNMATCHED, MATCHED, CONFLICTING, MANUAL_REVIEW, POSTED and REJECTED.
- Return totalCount and reviewableCount (UNSUPPORTED, UNMATCHED, CONFLICTING and MANUAL_REVIEW). Do not sum submitted amountCents into money received. If a claimed amount breakdown is ever exposed, it must be explicitly labelled unverified evidence and is not required for V1.
- The summary is count-only; the existing list and audited evidence-detail endpoint remain the drilldown path.

## 5. Revenue and collections semantics

These measures must remain distinct in the response and UI:

- **Billed:** RentCharge.amountDueCents grouped by the charge's billing period and chargeType.
- **Applied to charges:** confirmed PaymentAllocation amounts, grouped by charge period/type and Payment origin. CREDIT-origin applications are identified separately.
- **Open charges:** positive RentCharge.balanceCents for charges in UNPAID/PARTIAL states, grouped by period/type and exact Tenancy.
- **Gross receipts:** receipt-envelope amounts, grouped by the source's actual receipt date and source identity. Use ManualReceipt.amountCents, posted BankTransaction CREDIT amountCents and canonical posted MpesaTransaction acceptedAmountCents according to their source-specific state rules.
- **Available Tenant credit:** sum immutable TenantCreditMovement rows under the exact {clientId, estateId, tenantId} identity. Do not transfer or aggregate credit across estates.

Do not sum Payment.amountCents or Payment children to calculate gross cash: one source receipt may create several tenancy-specific Payments, and CREDIT-origin Payment rows consume an existing balance rather than represent new money. PaymentAllocation is the allocation destination record; it is not a second receipt.

Only confirmed/non-reversed G3 allocations count as applied amounts. A BankTransaction contributes to posted rent receipts only when it is a CREDIT and its G3 processing state is POSTED. An uncredited, unmatched or failed bank item remains Banking/reconciliation work, not rent collected. A ManualReceipt is reported once by its gross envelope amount; its child Payments are not added. M-PESA gross receipt totals reuse the existing receipt summary and are not reconstructed from linked Payments.

If a safe receipt identity cannot prove that two source records are distinct, do not silently add them into a single grand total. Return source-specific subtotals or expose the unresolved overlap explicitly.

### Charge period versus receipt date

A payment received in November may settle a September RentCharge. Report both facts:
- receipt period based on the authoritative source transaction/payment date;
- applied billing period based on PaymentAllocation.period / RentCharge.period.

Do not force cash receipts into the charge period merely because they were allocated there. Do not call amountPaidCents on RentCharge gross cash received; it is the charge settlement projection and can include credit applications.

### Collection-rate definition

Any percentage derived from charge settlement must be labelled as a charge settlement/charge collection rate and computed from selected-period charge obligations and settled allocations. It must not be presented as the percentage of gross cash receipts received in that month.

## 6. Arrears and credit semantics

- Include all open charge periods in the arrears report; the selected period is reference context, not a filter that hides older open obligations.
- Return exact tenancyId, houseId, tenantId, estateId, period, chargeType, amountDueCents, amountPaidCents, balanceCents, status and the saved RentCharge.dueDate.
- Determine overdue versus not-yet-due using the saved dueDate against a Nairobi calendar-date boundary. Do not recompute due dates from the current billing plan or from report generation time.
- Use server pagination with stable ordering and a bounded page size. The API must return items, total, page and limit. Do not depend on frontend slice(0, 100).
- Tenant credit is an account balance keyed by clientId + estateId + tenantId. Show it once at Tenant/Estate aggregation level. It must not be duplicated on each tenancy or used to clear another estate's debt.
- Do not automatically apportion a tenant-account credit to tenancy rows for display. Credit application order and allocation remain owned by the G3 tenant-credit service.
- Current ledger balance inspection returns historicalCoverage UNVERIFIED and verifiedFullObligation false. Until a separate completeness contract proves full historical coverage, report known open charge balances and available credit separately; do not label the derived net as verified total arrears or replace unavailable values with zero.

## 7. Occupancy semantics

- Scope Houses by clientId, estateFilter and isActive.
- Use authoritative ACTIVE Tenancy relationships for current occupancy; do not infer tenancy identity from mutable Tenant.houseId or House.tenantId compatibility pointers.
- Occupied houses are distinct active Houses with an eligible ACTIVE Tenancy; vacant houses are active Houses without one. Validate/report inconsistent House.status versus Tenancy state rather than silently counting the same House twice.
- Tenant count is distinct Tenant identity, not number of active Tenancy rows.
- House-type breakdown comes from each House's houseTypeId; retain an explicit Unclassified bucket.

## 8. M-PESA summary semantics

The existing src/services/mpesaReceiptSummary.js is the metric contract and must be reused unchanged unless a separately reviewed defect is found.

- Source: canonical MpesaTransaction only; use acceptedAmountCents, never raw provider payload.
- Each receipt belongs to exactly one state bucket: POSTED, QUARANTINED, UNALLOCATED or ATTRIBUTED. These buckets reconcile to providerObserved.
- verification is an independent view of the same receipts and also reconciles to providerObserved. It must not be added to state totals.
- POSTED means a G3 Payment has been created through the existing posting path. It is counted once from the canonical receipt, not again from Payment or PaymentAllocation children.
- UNALLOCATED and QUARANTINED receipts are not rent collected.
- Estate-restricted scope must continue to use the existing exact allocatedEstateId / attributedEstateId receiptScopeClause. Membership in a shared merchant profile is never sufficient to expose or aggregate a receipt for an estate.
- Do not add a per-Till aggregate to V1 unless a safe merchant/estate attribution rule and privacy behavior are separately demonstrated.

## 9. API and implementation plan

1. Refine reportService.dashboard/managementSummary for the approved Overview, Revenue and Occupancy metrics; retain all current financial null/unknown protections.
2. Replace the unbounded arrears detail in the management bundle with compact arrears summary metrics.
3. Extend GET /reports/arrears to a paginated DTO and return tenancyId plus overdue classification. Confirm there are no other in-repository consumers relying on the legacy array contract; coordinate DTO changes with the paired frontend branch.
4. Add the validated GET /mpesa-collection/submissions/summary endpoint and aggregate service. Reuse MpesaSmsSubmission states and createdAt.
5. Reuse GET /mpesa-transactions/summary without duplicating its classifier.
6. Add source-identity and projection-versus-allocation regression tests before enabling the new UI.

No new model is required by this contract. Any new index must follow the repository's migration/readiness policy and be justified by query-plan evidence, not added speculatively.

## 10. Acceptance and test gates

- A single receipt split across multiple Payment children contributes its gross amount once.
- CREDIT-origin Payments reduce existing Tenant credit and never increase gross cash.
- PaymentAllocation and RentCharge projections reconcile for billed/applied/open charge figures.
- Receipt date and allocation billing period remain independently reportable.
- Reversed Payments do not contribute as confirmed allocations.
- ManualReceipt gross amount is not added to its child Payment rows.
- Only posted BankTransaction CREDIT and posted MpesaTransaction receipts contribute to posted-source collection totals.
- M-PESA state and verification totals each reconcile to providerObserved; the two breakdowns are not additive.
- SMS submission summary returns every defined state count, respects createdAt windows and estate scope, and never labels an SMS claim as money received.
- Restricted estate user cannot observe or aggregate another estate's M-PESA receipts or SMS submissions; client identity cannot be selected or widened by an ordinary client user.
- Arrears pagination covers records beyond 100 without duplicates, omissions or unstable ordering.
- Due-date classification uses Nairobi date semantics and saved dueDate.
- Tenant credit is aggregated once per tenant+estate and does not net across estates.
- Missing/unverified historical coverage is represented explicitly; no false zero or verified net arrears is produced.
- Occupancy counts distinct active Houses and distinct Tenants, with no duplicate occupancy from multiple Tenancy rows.
- Existing G3 posting, G4 reconciliation and G5 ingestion/claim/posting tests remain unchanged and pass in the appropriate environment.

**Verification status:** This is a documentation contract. No implementation, test execution, production readiness or live provider behavior is claimed by this document.