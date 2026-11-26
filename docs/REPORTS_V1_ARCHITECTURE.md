# Reports V1 — Backend Architecture

**Status:** Approved reporting design, 26 November 2026  
**Repository:** jolla3/tycoon-estates-backend  
**Branch:** docs/reports-v1-20261126  
**Base:** main @ a05b89830ca68608d473241a28fa6ea9f73e9923  
**Companion:** REPORTS_V1_PRD.md

## 1. Architectural boundary

Reports is a read-only aggregation layer over existing domain records. It must not own payment identity, receipt verification, allocation, tenant-credit settlement, occupancy lifecycle or a new ledger. Each domain remains the source of truth; report services provide bounded, client/estate-scoped projections.

The reporting layer spans existing G3 charges/payments/credit, G4 imported bank transactions, and G5 canonical M-PESA receipts/submitted evidence. This does not make G4 a G5 feature and does not change either product's write workflows.

## 2. Existing source model map

| Report concept | Authoritative records | Important distinction |
|---|---|---|
| Portfolio / occupancy | Estate, House, Tenancy, Tenant, HouseType | ACTIVE Tenancy is authoritative; mutable tenant/house pointers are compatibility fields |
| Billed obligations | RentCharge | Group by charge period and chargeType |
| Applied amounts | PaymentAllocation joined to Payment | Child allocations are not gross receipt envelopes; Payment origin CREDIT is existing credit |
| Tenant credit | TenantCreditMovement | Immutable movements, account key {clientId, estateId, tenantId}; no cross-estate netting |
| Manual receipts | ManualReceipt | One gross envelope; child Payments/allocations must not be added again |
| Bank receipts | BankTransaction | Only CREDIT records with processingState POSTED belong in posted rent-source totals; unmatched bank items remain Banking work |
| M-PESA receipts | MpesaTransaction | Canonical merchant-side receipt, uses acceptedAmountCents and posting/verification/allocation states |
| M-PESA SMS claims | MpesaSmsSubmission | Evidence states and parsed amount are not money received |

## 3. Reporting request flow and authorization

Authenticated report requests follow the existing apiRoutes -> authenticate -> clientContext -> controller -> report service path.

- clientContext derives clientId from the authenticated session (ordinary client users cannot select another client).
- The optional estateId query is validated by clientContext against the user's assigned estateIds and becomes req.estateFilter.
- Services must pass req.estateFilter through estateFilterClause or the M-PESA receiptScopeClause. A null filter means full access within the selected client; an array means a restricted allowed-estate set.
- SUPER_ADMIN must provide one explicit clientId for client-scoped report endpoints.
- M-PESA routes retain requireProduct('MPESA'). No frontend-only or aggregate-service bypass is permitted.
- Receipt scope for estate-restricted users remains exact allocatedEstateId / attributedEstateId. A shared merchant mapping is not proof that every receipt belongs to every mapped estate.

Every new summary contract must carry the same client and estate scope as its detail/list counterpart. Test that the totals and drilldown rows use identical predicates.

## 4. Existing endpoints to reuse

### 4.1 Management summary

GET /reports/management already returns portfolio, RentCharge-based status/collection aggregates, by-estate and by-house-type information, bank and SMS rollups. V1 should refine the DTO and metric labels rather than add another report controller.

The current implementation also returns an unbounded arrears detail array from reportService.arrears. Replace that detail payload with compact aggregate metrics; the paginated arrears endpoint becomes the only source for arrears rows.

### 4.2 Canonical M-PESA receipt summary

GET /mpesa-transactions/summary is already implemented and protected by authenticate, clientContext and requireProduct('MPESA'). Its route requires startDate/endDate and optional estateId; the date window is bounded to 93 days.

mpesaTransactionService.summary calls inspectMpesaIndexes and then the pure summarizeReceipts reducer in mpesaReceiptSummary.js. The metric contract is already explicit:
- providerObserved uses acceptedAmountCents from canonical MpesaTransaction.
- states are mutually exclusive: POSTED, QUARANTINED, UNALLOCATED, ATTRIBUTED.
- verification is a separate breakdown of those same rows.
- posted includes receiptCount, paymentCount, gross amount and creditEarnedCents.
- byEstate groups by exact allocatedEstateId or attributedEstateId; unallocated is a client-wide-only bucket.

Do not copy/rewrite this reducer in reportService. The frontend already has mpesaTransactionsApi.summary, MpesaSummary DTO, periodWindow, summaryRows, summaryReconciles and MpesaSummaryCard. Reuse the existing API and view helpers; wire the data into Reports rather than creating a second receipt-summary model.

### 4.3 New submission-state summary

Add a sibling summary method in mpesaSubmissionReview.service.js and a route in mpesaCollection.routes.js:

GET /mpesa-collection/submissions/summary?startDate={ISO}&endDate={ISO}&estateId={optional}

The route reuses the current base middleware and admin/reviewer policy. Validate a bounded date window (maximum 93 days). Query MpesaSmsSubmission by clientId, estateFilterClause and createdAt. Aggregate counts for each SUBMISSION_STATE and total/reviewable counts. This endpoint returns counts only. It must not select evidenceEnvelope or expose raw SMS, digest, key id, parser secrets, payer details or amount claims as received money.

## 5. Revenue aggregation design

There are two independent measures: obligations settled and gross receipt envelopes.

### 5.1 Charge / allocation view

- RentCharge.amountDueCents gives billed obligation by charge period/type.
- PaymentAllocation is the authoritative charge-application detail; join Payment to classify source origin and status.
- PaymentAllocation.period is the charge period settled, not necessarily the month the receipt arrived.
- CREDIT-origin Payment/allocation is settlement from previously held Tenant credit, not a new cash receipt.
- RentCharge.amountPaidCents is a projection of applied allocations and therefore must be labelled applied/settled, not gross cash collected.
- Compare PaymentAllocation sums with RentCharge projections in tests; do not rebuild or mutate projections inside reporting.

### 5.2 Gross receipt-envelope view

Count source envelopes once:
- ManualReceipt.amountCents by its authoritative paymentDate.
- BankTransaction.amountCents only for eventType CREDIT and processingState POSTED, by transactionDate.
- MpesaTransaction.acceptedAmountCents only for postingState POSTED, by transactionAt; use the existing M-PESA summary result.

Do not add child Payment amounts, PaymentAllocation amounts or TenantCreditMovement rows on top of source gross receipts. Those represent allocation or credit settlement, not a second incoming receipt.

Do not include unmatched/failed BankTransaction credits as rent collected. They belong to Banking/reconciliation review. Unverified, unallocated or attributed-but-not-posted M-PESA receipts remain in their dedicated receipt-state reporting and are not posted rent totals.

If an operator-recorded ManualReceipt and a provider receipt might describe the same physical receipt, only combine them into a portfolio grand total when an exact, tested identity/deduplication rule establishes that they are distinct. Otherwise retain source-specific totals and make the overlap limitation explicit. The free-form/tender label alone is not proof of provider identity.

## 6. Arrears read model

The current reportService.arrears query spans all open periods but returns an unbounded array and omits tenancyId from its mapped DTO. V1 changes it to stable server pagination:

Request: period (reference only), estateId (optional), page, limit, overdueOnly (optional).  
Response: items, total, page, limit.

Each item includes client/estate/tenant/house/tenancy identifiers, display names, period, chargeType, amountDueCents, amountPaidCents, balanceCents, status, saved dueDate and overdue flag. Sort deterministically by dueDate, period, houseId and _id. Clamp limit to a documented maximum.

The management bundle returns compact arrears totals (open charge count/amount and overdue versus not-yet-due totals), not the full row list.

TenantCreditMovement is aggregated once for each {clientId, estateId, tenantId}. It must not be repeated on individual tenancy rows. A report may show recorded open charges and credit side by side. It may expose a derived net of known records only if clearly marked as incomplete; verified total arrears requires an authoritative historicalCoverage/verifiedFullObligation contract. The current ledger balance implementation reports UNVERIFIED, so V1 must not infer complete coverage.

## 7. Occupancy aggregation

Aggregate active Houses by estate and House.houseTypeId; use Tenancy status ACTIVE and exact {clientId, estateId, houseId} relationships to determine occupied Houses. Count distinct Houses and distinct Tenant ids. Keep unclassified Houses in a named bucket. Compare House.status to active Tenancy existence and report inconsistent source records as an operational integrity condition rather than inventing a second occupancy identity.

No occupancy history table or snapshot exists in this contract. V1 is a current snapshot, not an occupancy trend report.

## 8. Period and timezone rules

- Reports billing period is YYYY-MM in Africa/Nairobi.
- Charge period comes from RentCharge/PaymentAllocation.period.
- Receipt date comes from ManualReceipt.paymentDate, BankTransaction.transactionDate or MpesaTransaction.transactionAt.
- Submission date comes from MpesaSmsSubmission.createdAt.
- Convert one selected Nairobi month into exact UTC instants at the API boundary. Do not compare date strings or mix SMS transaction time with submission received time.
- Existing M-PESA summary is limited to 93 days; one month is within that contract.

## 9. Performance and indexes

Prefer grouped aggregates/projections and bounded pagination. Reuse existing M-PESA index readiness gates. Inspect Mongo query plans for report summaries at realistic client/estate sizes. Add an index or migration only when explain output demonstrates the need; follow the backend's migration, readiness and production-safety policy. Never allow a reporting query to return full encrypted evidence envelopes or raw provider payloads.

## 10. Delivery order and acceptance

1. Write metric definitions and DTO tests before touching route implementation.
2. Refine management summary and cash/allocation aggregates.
3. Add paginated arrears DTO and remove the embedded unbounded list.
4. Add M-PESA submission count summary; reuse canonical receipt summary.
5. Implement frontend integration on the paired Reports branch.
6. Verify client/estate isolation, entitlement gates, reconciliation of receipt buckets, receipt-versus-child-payment single counting, credit separation, reversed payments, dates, pagination and occupancy counts.
7. Run existing G3/G4/G5 regression suites appropriate to changed paths.

No new financial model, posting pathway, second ledger, provider operation, or frontend-authored financial rule is introduced.