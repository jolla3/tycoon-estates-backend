# Manual payments: explicit tenant, receipt history, credit accounting

## API contract
`POST /payments` (CLIENT_OWNER/CLIENT_ADMIN) now REQUIRES
`tenantId, tenancyId, houseId, amountCents, paymentDate (Nairobi YYYY-MM-DD), tenderMethod, idempotencyKey`
(optional `paymentReference`, `period`). The server validates, inside the transaction, that
the house is in the caller's client/estate scope, the tenancy belongs to that house and tenant,
the tenant is in the same client+estate, the tenancy status is ACTIVE/CLOSED and the tenancy
covered the payment day (start inclusive, end exclusive). Any mismatch returns 400
`INVALID_REQUEST` with one generic message (ids cannot be probed). The house's current occupant
is never substituted, so a backdated receipt goes to the former tenant when explicitly chosen.
Idempotent replay requires the same house, tenant, tenancy, amount, date, method and reference;
a reused key with different details is 409.

`GET /payments/tenant-context?tenantId=&paymentDate=` returns the tenant, their tenancies
(`houseNumber`, `status`, dates, `coversPaymentDate`) and `account {creditCents, outstandingCents, netCents}`.
`GET /payments` rows add `tenantName`, `houseNumber`, `isMoneyReceived` (false for CREDIT-origin rows).
`GET /tenants/:id` adds `account` and `paymentHistory`.

## Financial semantics (never interchangeable)
- received: gross money in = ManualReceipt gross + non-child M-PESA/BANK/legacy Payments + M-PESA surplus.
  Existing-credit applications are not received money.
- appliedToRent: sum of allocations on the tenant's own charges (from receipts and from credit).
- credit: sum of immutable TenantCreditMovement rows only (never Payments).
- outstanding: open balances on the tenant's own charges; net = credit - outstanding.
- Invariant per receipt: gross = receiptApplied + newCredit; credit used is reported separately.
- The selected house sets source/ownership only; settlement still spans the tenant's eligible tenancies in the estate.
- `financials.paidCents` on the tenant API now means applied to rent, not received.

## Operations
No migration is required; `uniq_client_manual_receipt_idempotency` and
`uniq_client_manual_receipt_reference` are unchanged and still required by readiness checks.
No production data is modified. To investigate a tenant's credit, read their ManualReceipts and
TenantCreditMovements (each movement carries `manualReceiptId`).
