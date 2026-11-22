# G3 — Tenancy, Rent, Payments, Tenant Credit and Deposits

**Status:** Current-source requirements and corrective specification, 21 November 2026  
**Backend baseline:** `main` `0dbf7ef75ed6c1a39e24775aec9a86e08f7d0617`  
**Frontend baseline:** `main` `a27f20dd3244cdc7370cffa16b70c6cd32a45576`

## 1. Product

G3 is Tycoon Estates' financial system of record for landlord- and house-centric property operations. It connects exact tenancy identity to rent obligations, payments, allocations, ledger movements, tenant credit and separately held security deposits. The primary users are property owners, administrators and staff. This is not a tenant self-service rent dashboard.

## 2. Product invariants

1. Tenant is a person/account identity; Tenancy is the exact occupancy relationship. A Tenant may have several active Tenancies, including in different Houses in the same Estate.
2. Every rent charge, rent allocation and deposit movement belongs to an exact Tenancy. Never select an arbitrary active Tenancy for a Tenant.
3. Payer identity does not establish Tenant or Tenancy identity.
4. Rent and security deposits are separate accounting categories. Deposit receipts/refunds do not silently alter rent arrears or tenant rent credit.
5. Tenant credit is scoped by `{clientId, estateId, tenantId}` and is applied oldest-first to eligible obligations across that Tenant's Tenancies in the same Estate. It is not a global or cross-Estate wallet.
6. Provider observations are evidence, not posted rent. G3 Payment, PaymentAllocation and Ledger state remain the posting authority.
7. Historical charges and ledger movements are not silently rewritten. Corrections use explicit, auditable adjustments or compensating movements.
8. Authenticated API mutations retain cookie sessions and CSRF protection. CORS must allow the actual documented request headers without weakening that protection.

## 3. Existing behavior confirmed in current source

### Rent, credits and HouseType plans

- Monthly rent generation currently selects Tenancies covering the full billing month. Partial-period Tenancies are returned as excluded; no proration formula is implemented.
- HouseType plan changes are versioned prospectively. For Houses with `billingSource === 'HOUSE_TYPE'`, charge generation resolves the plan version effective for the requested period. Existing Houses using that source can inherit a future version.
- Tenant credit auto-application after billing already exists. It enumerates the Tenant's eligible Tenancies and open charges within the same Estate and applies credit oldest-first. Do not build a second wallet or duplicate this behavior.

### Manual payments

- The backend resolver evaluates the complete eligible Tenancy set and distinguishes no match, one match and ambiguity.
- The UI uses a capped 20-item `eligibleOptions` array in the ambiguous case, so candidates after the first 20 cannot be selected even though the backend knows the full eligible count.
- No manual payment may be posted until an exact `tenancyId` has been selected.

### Deposits

- Deposit records and movements are Tenancy-scoped, but the current public service/routes accept `tenantId` and call `findOne()` for an active Tenancy.
- The Tenancy model permits one active Tenancy per House, not one per Tenant. Tenant-level resolution is therefore ambiguous, and the current lookup also omits the Estate filter on the Tenancy query.
- Deposit requirement changes after payment can return the existing unchanged requirement while auditing the newly requested amount. This must not be presented as a successful update.
- The payment path can create a Deposit with its required amount set to the payment amount when no requirement exists. The intended policy is not established.
- `settle()` records `settledAt` and recomputes status. It does not create a refund movement/Ledger entry or close the Tenancy/House. The current frontend's refund-and-move-out promise is inaccurate.

## 4. Required corrections

### G3-01 — Exact tenancy selection

All deposit reads and mutations must identify the exact `{clientId, estateId, tenancyId}`. Validate Tenancy ownership and Estate scope on every operation. A legacy Tenant-ID route may remain temporarily only when exactly one eligible Tenancy is found; return a typed ambiguity conflict when more than one exists. Never guess.

### G3-02 — Deposit accounting and truthful lifecycle

For any DepositMovement type that is already supported and explicitly permitted by owner policy, the DepositMovement and matching deposit-category Ledger movement must commit atomically with idempotency. This accounting invariant does not authorize expanding standalone deduction/refund behavior in this change. A `settled` status must not claim that funds were refunded. The combined deduction/refund/move-out workflow is blocked until the owner approves deduction rules, rent-arrears treatment, refund calculation and atomic Tenancy/House-close rules. Until then, the UI must not promise refund or move-out.

For this implementation, any attempt to change a deposit requirement after a payment has been recorded must return a typed `409 Conflict` and leave the Deposit and Ledger unchanged. Do not implement a paid-requirement adjustment. A future adjustment feature requires a separate owner-approved accounting policy and scope.

### G3-03 — Complete manual-payment selection

The operator must be able to search and page through the complete eligible Tenancy set when multiple candidates match. Use the same eligibility predicate as the resolver. A page limit may bound one response, never the total selectable population. Preserve the exact selected `tenancyId` in the create request.

### G3-04 — Versioned HouseType editing

Provide HouseType plan editing from both list and workspace surfaces. Show the effective billing period, change reason and which existing Houses using `HOUSE_TYPE` billing will consume the new version. Existing charges and historical plan snapshots remain unchanged. Do not describe plan changes as affecting only new Houses.

### G3-05 — CORS/idempotency request contract

The authenticated client sends credentials and CSRF on mutations and may send `Idempotency-Key`. CORS must allow `Content-Type`, `X-CSRF-Token` and `Idempotency-Key` for the configured origins. Keep Origin validation, credentials and CSRF enforcement. Do not solve a preflight defect by disabling CSRF or removing idempotency.

### G3-06 — Reporting source distinction

Where M-PESA reporting aggregates are exposed, distinguish provider-observed receipts, verified/attributed receipts, unallocated or quarantined receipts, and G3 Payments actually posted. Never sum a receipt and its resulting Payment as two collections. Transaction history is not a substitute for aggregate reporting. Optional Banking/SMS report surfaces must respect product entitlement.

### G3-07 — Partial-period billing remains blocked

Do not add proration until the owner approves start/end inclusivity, timezone boundary, denominator, month-length handling, move-in/move-out behavior, charge types and historical snapshot policy. Preserve the current full-month-only behavior until then.

## 5. Out of scope / do not rebuild

- A replacement rent ledger, Payment model, allocation engine or reconciliation engine.
- Duplicate Tenant-credit application logic.
- A cross-Estate Tenant wallet.
- Proration, deposit-to-rent transfers or automatic refund policies based on engineering assumptions.
- Authentication redesign to work around CORS.
- Production index migrations or provider activation as part of a UI/API correction.

## 6. Owner decisions required before deposit lifecycle expansion

1. Whether move-out refunds all remaining held funds or first applies explicit deductions, and who may approve each action.
2. Whether deposit refund, settlement, Tenancy closure and House vacancy must be one transaction or separate explicit commands.
3. No paid-requirement adjustment is permitted in the current scope. Any future adjustment requires an owner-approved accounting rule and explicit representation.
4. Whether deposit payments are blocked until a requirement exists, and how excess payment is treated.
5. Whether HouseType carries a default deposit amount or deposits remain Tenancy-specific.

## 7. Acceptance gates

- Multi-Tenancy and cross-Estate tests prove exact selection, conflict behavior and access isolation.
- Replica-set tests prove deposit movement/Ledger atomicity, refund, rollback, idempotent retries and concurrent mutation safety.
- Manual-payment tests prove more than 20 and more than 50 eligible Tenancies remain searchable/selectable.
- HouseType tests prove effective-version selection and historical-charge immutability.
- CORS tests prove the exact credentialed OPTIONS header contract and valid/invalid CSRF behavior.
- Financial regressions cover manual, BANK, MPESA, CREDIT and deposit categories separately.
- Do not report live provider readiness, production migration success or browser acceptance from source inspection alone.
