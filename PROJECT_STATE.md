# Tycoon Estates — Project State

**Last updated:** 2026-11-07
**Current milestone:** G3 — Category B Foundation Implementation
**Status:** INCOMPLETE — recovery applied, completion evidence outstanding.

## 1. Canonical repository

- Local path: `/home/jolla/Projects/web/tycoon-estates-backend`
- Remote: `https://github.com/jolla3/tycoon-estates-backend.git`
- Base branch: `main`
- Feature branch: `feature/category-b-foundation`
- Baseline SHA: `569c96c8f6a017c114e9abbe8b5f15b72d6e934a`
- Current G3 changes: recovered, uncommitted.
- No G3 commit, push or PR exists.

This local repository is the authoritative project workspace.

## 2. Product

Tycoon Estates is a multi-client property and rent-payment monitoring backend.

The current project objective is to establish immutable tenancy identity and tenancy-aware accounting before enabling M-PESA PayBill collection.

Core financial concepts:
- Tenant: person or organization.
- Tenancy: one occupancy period.
- RentCharge: billed obligation.
- Payment: confirmed financial receipt.
- PaymentAllocation: allocation of Payment to RentCharge.
- Ledger: authoritative financial movements.
- Deposit: tenancy-specific liability.
- BankTransaction: Co-op bank-specific incoming transaction.

M-PESA remains a later, separately gated collection integration.

## 3. Approved design

Read these files before implementation:
- PRD.md
- architecture.md
- architecture-summary.md

G2 design revision: 2026-11-07.

Non-negotiable rules:
- Every new financial payment is associated with a specific Tenancy.
- Allocation cannot cross Tenancy boundaries.
- Old occupant debt does not transfer to a new occupant.
- Manual payments remain supported.
- BANK and future MPESA origins remain separate.
- BankTransaction remains bank-specific.
- Deposit belongs to a Tenancy.
- Ledger remains singular and authoritative.
- Multi-document financial writes require MongoDB transactions.
- Unattributed history must not be assigned by guesswork.
- Runtime startup must not destructively synchronize indexes.
- M-PESA posting cannot begin before Co-op compatibility approval.

## 4. G1 evidence

Canonical baseline was verified at:
`569c96c8f6a017c114e9abbe8b5f15b72d6e934a`

Reported DB-free unit baseline:
- 10 suites passed.
- 34 tests passed.
- Redis concurrency test excluded.
- MongoDB integration tests not run at G1.

These results describe G1, not the current recovered G3 implementation.

## 5. G3 recovery

Recovery archive:
`~/Downloads/g3-category-b-recovery-20261107.tar.gz`

Reported SHA-256:
`86c08c61972e5a1c392b04f567373ee00a8b51576dc230b3ca8d89d6c9dea248`

Inspection directory:
`~/Projects/tycoon-estates-recovery-inspect/g3-recovery-stage`

Recovery verification:
- Archive SHA-256 matched.
- Internal MANIFEST.sha256 passed.
- Tracked patch copies were identical.
- Patch applied once.
- All included source snapshots matched the recovered repository.
- `git diff --check` passed.

Recovered tracked modifications:
- BankTransaction, Deposit, Ledger, Payment and RentCharge models.
- Webhook and bank services.
- Deposit, billing, ledger, payment, reconciliation, rent, SMS, tenant, transaction and tenancy services.
- Index utility and error utility.

Recovered new files:
- `src/models/Tenancy.js`
- `src/services/tenancy.service.js`

G2 documents restored:
- PRD.md
- architecture.md
- architecture-summary.md

Important archive limitation:
The reported new G3 tests and migration scripts were not present in the recovery archive manifest. The archive's untracked tests and scripts directories were empty. Their existence and reported test evidence must not be assumed.

## 6. G3 implementation status

Reported implementation, recovered but not independently re-tested:
- Tenancy lifecycle and transaction-based moves.
- Tenancy-aware core RentCharge paths.
- BANK and MANUAL Payment origins.
- Tenancy-scoped Ledger core.
- Deposit model and partial service rewrite.
- Estate-scoped Co-op matching.
- Retryable processing states.
- Non-destructive startup index policy.
- Billing effective-date filtering.
- assignToHouse rentCharge defect correction.

Outstanding work:
1. Verify allocation isolation in every applyPayment path.
2. Complete Deposit service review and tests.
3. Audit all report and dashboard callers.
4. Audit all jobs and SMS arrears callers.
5. Verify every individual balance query is Tenancy-scoped.
6. Verify CLAIMED lease expiry and crash recovery.
7. Reconstruct missing migration assessment and test artifacts.
8. Run the complete safe test matrix against a disposable MongoDB replica set.
9. Re-run Co-op webhook, polling, reconciliation and isolation tests.

G3 is NOT COMPLETE.

## 7. Test history and limitations

The recovery report records:
- 14 suites / 46 tests passed during an earlier stable disposable replica-set session.
- Later unit run: 11 suites / 38 tests passed.
- Later integration run experienced failures/open handles.
- Full webhook, reconciliation, isolation and concurrency matrix was not reliably re-proven.

These are historical agent-reported results, not a fresh test run on this local recovered checkout.

No production or shared application database was used for the reported G3 tests.

## 8. Current authorization

Authorized:
- Inspect and finish G3.
- Add/update source and tests required by approved G2 design.
- Use an isolated disposable MongoDB replica set.
- Produce a read-only legacy assessment.

Not authorized:
- M-PESA or Daraja implementation.
- Production data migration.
- Production index changes.
- Commits, pushes or PRs.
- Changes to G2 architecture documents without separate approval.

## 9. Next milestone

Finish G3, prove financial and tenancy correctness, and return a complete implementation report.

G4 Co-op compatibility and G5 Daraja contract proof follow only after G3 review.
