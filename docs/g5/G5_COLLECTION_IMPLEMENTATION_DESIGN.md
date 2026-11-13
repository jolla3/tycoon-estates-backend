# G5 collection slices (G5.3 submission, G5.6 claims, G5.7 posting) — Tenant M-PESA collection, attribution and G3 posting

Status vocabulary used here (kept distinct on purpose):
- **Published code**: present on `feature/g5-construction`.
- **Verified by tests**: unit tests run; replica-set integration tests are written but only count as verified when actually run against a disposable replica set.
- **Blocked by provider evidence**: gates B01–B05, B07–B10 (unchanged, fail-closed).
- **Production readiness**: NOT claimed. Posting is disabled by default (`G5_MPESA_POSTING_ENABLED` != `1`).

## 1. Architecture critique (answers)
1. *Receipt identity.* Canonical receipt uniqueness stays the provisional `{provider, businessShortCode, receiptNumber}` index on `MpesaTransaction`, migration-controlled and NOT activated (B01/B02). Posting refuses while `gates.canonicalReceiptIdentity` is false. The new `Payment {mpesaReceiptId, tenancyId}` index is only child-identity, never a substitute.
2. *Single posting authority.* `MpesaTransaction` is the claim record. A write-bearing conditional `findOneAndUpdate` sets `postingLeaseToken` (random), expiry, increments attempts. The final transaction step is a conditional update requiring the same token and an unexpired lease; a stale worker's update matches 0 documents and the whole MongoDB transaction aborts.
3. *Two Tenants claiming one receipt.* Attribution fields (`attributedTenantId`, …) are set only while null in the same conditional claim; a different Tenant's submission becomes CONFLICTING, never reassigned.
4. *Third-party payers.* Payer MSISDN/name are never compared with Tenant data and are not stored.
5. *Submitted SMS is evidence, never proof.* Only a provider-verified canonical receipt can post.
6. *Credit.* G3 ledger credit is per-Tenancy; allocator `planAllocation` puts excess on the last charge (OVERPAID). Neither fits Tenant-level surplus, so surplus is an immutable `TenantCreditMovement` (derived balance).

## 2. Tenant credit design
- Collection `tenantcreditmovements`, scope `{clientId, estateId, tenantId}`, immutable (update/delete hooks throw), types RECEIPT_SURPLUS (+), CREDIT_APPLIED (−), ADJUSTMENT.
- Balance = sum of movements. Serialization: non-monetary `Tenant.creditRev` is incremented inside the transaction before reading the balance.
- Idempotency key unique per Tenant (`receipt:<txnId>:surplus`, `receipt:<txnId>:<tenancyId>`, `auto:<rev>:<tenancyId>`).
- Application of credit = `Payment{origin:'CREDIT', creditApplicationKey}` + PaymentAllocations + Ledger `SETTLEMENT` per Tenancy + CREDIT_APPLIED movement. Receipt surplus is not posted on any Tenancy ledger.
- No cross-tenant/estate leakage; B07 historical-coverage limitation preserved (credit is not back-dated against pre-G3 history).

## 3. Allocation order (total, deterministic)
period → dueDate (null last) → chargeType (RENT<WATER<ELECTRICITY<OTHER) → Tenancy startAt → tenancyId → chargeId. Oldest obligation first across the Tenant's ACTIVE and CLOSED Tenancies in the same Client/Estate. Charges are never created for closed Tenancies. The planner never allocates beyond a charge balance. Two stages: existing credit first, then the receipt; remainder = new credit. Invariants: `receipt = applied + newCredit`; `credit = applied + remaining`.

## 4. Posting transaction (single MongoDB transaction)
Gates → claim lease → bump `Tenant.creditRev` → bump Tenancy `ledgerRev` (sorted ids) → bump charge `allocationRev` (sorted ids) → child Payments `origin:'MPESA'`, `mpesaReceiptId=MpesaTransaction._id` (one per Tenancy portion) → PaymentAllocations → RentCharge projections from allocations → Ledger PAYMENT entries → credit movements → fenced finalize (`paymentIds[]`, `POSTED`, `creditEarnedCents`) → submission POSTED → audit. SMS is queued only after commit.

## 5. Payment index migration
`scripts/migrations/20261113_g5_payment_receipt_tenancy_index.js`: dry-run default; duplicate preflight on `{mpesaReceiptId, tenancyId}`; `--execute` with DB/host allowlists; drops the legacy unique `mpesaReceiptId_1`, creates `uniq_payment_mpesa_receipt_tenancy` (partial `origin:'MPESA'`) and `uniq_payment_credit_application_key`; exact post-verification. Not run against production. Other G5 uniques (link tenant/token digest, submission evidence, credit movement key) are installed by `20261113_g5_collection_indexes.js` with the same guards. No unique index is auto-created at startup.

## 6. Public submission link
256-bit CSPRNG token (base64url, 43 chars), only a keyed HMAC digest stored (`G5_LINK_TOKEN_PEPPER`), constant-time compare. One link per `{clientId, estateId, tenantId}`; rotation/revocation via `linkVersion` CAS. Link is non-operational unless the merchant profile is ACTIVE with an unambiguous estate mapping. Public API: `POST /public/mpesa-submissions` with token in the JSON body (page reads it from URL fragment). No cookies/CSRF; own bounded body parser mounted before the global parser; `Cache-Control: no-store`, `Referrer-Policy: no-referrer`, restrictive CSP; neutral responses; Redis-backed limiter with an in-process fallback that fails CLOSED. The HTML page is a frontend-boundary deliverable and is not in this backend repo.

## 7. Evidence and SMS outbox encryption
Versioned AES-256-GCM envelope `g5e1.<keyId>.…` with AAD, dedicated keys (`G5_ENVELOPE_KEYS`, `G5_EVIDENCE_DIGEST_KEY`). Raw submitted text is NOT retained while retention policy is pending (B05); only digest + parsed allowlisted fields. Protected SMS: `deliveryMode G5_PROTECTED`, encrypted phone+body, fenced dispatch lease, durable `sendStartedAt`, ordinary worker excludes it, Celcom `unknown` never retried.

## 8. Gates (all remain unresolved / fail-closed)
B01 merchant hierarchy identity, B02 canonical receipt uniqueness, B03 credential model, B04 timestamp semantics + real SMS captures, B05 evidence retention/recovery, B07 historical coverage, B08 Till operational proof, B09 credentials, B10 manual-resolution approval policy. Nothing here activates any of them.
