# G5.3 — Daraja Provider Ingestion Design (Buy Goods / Till)

**Status:** Corrected implementation on `feature/g5-construction` (sandbox-first).
**Does not authorize:** Tenant attribution, SMS links, G3 Payment posting, production registration, or live financial ops.

## Boundary

Provider verification only. C2B + Pull share one durable inbox and one canonical reconciliation boundary. G3 remains untouched.

## Index control (acceptance)

- `MpesaMerchantProfile`, `MpesaPullCheckpoint`, `MpesaIngestionEvent`, `MpesaTransaction` use `autoIndex: false`.
- Unique merchant `{clientId, businessShortCode}` and checkpoint `{merchantProfileId}` indexes are installed only by `scripts/migrations/20261112_g53_mpesa_merchant_index.js`.
- Migration enforces G5/G3 database-name and MongoDB host allowlists; dry-run is default; production-named DBs are refused.
- `inspectMpesaIndexes()` verifies exact key order, uniqueness and index names for separate gates: inbox, merchant, canonical identity (always false until B01/B02), Pull.

## Pull checkpoint safety (acceptance)

- Scheduled Pull requires `DARAJA_PULL_RECONCILIATION_ENABLED=1` (default off).
- `allPersisted` is true only for recognized `empty_valid` or fully persisted `rows`.
- `empty_body` / `unsupported` never advance checkpoints.
- Non-empty pages persist rows but do **not** close the time window while pagination is unresolved.
- Successful Pull **registration** updates `pullRegistrationState` only — it does **not** set `pullCapability: VERIFIED`.

## Inbox crash safety (acceptance)

1. Persist event (ack gate) remains outside the processing transaction.
2. `processClaimedEvent` opens a MongoDB transaction when no session is supplied.
3. Canonical candidate update and event completion commit together under the lease fence.
4. Transaction failure leaves the event recoverable (`PROCESSING` / `FAILED_RETRYABLE`); never `PROCESSED` outside a successful commit.

## Contract evidence

See `docs/provider-contracts/G5_DARAJA_C2B_PULL_EVIDENCE.md`. C2B v1/v2, Pull GET/POST, pagination, and B01/B02 remain unresolved as classified there.

## Explicit non-goals

- SMS / submission links / Tenant claim / G3 posting / PayBill / production Go-Live
