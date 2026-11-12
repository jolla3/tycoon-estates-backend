# G5.3 — Daraja Provider Ingestion Design (Buy Goods / Till)

**Status:** Corrected implementation on `feature/g5-construction` (sandbox-first).
**Does not authorize:** Tenant attribution, SMS links, G3 Payment posting, production registration, or live financial ops.

## Boundary

```
OAuth → Merchant Profile registration lifecycle
             |
     +-------+-------+
     |               |
C2B Registration  Pull Registration
     |               |
C2B Confirmation  Pull Reconciliation job
     |               |
     +-------+-------+
             |
   Durable MpesaIngestionEvent (persist → lease → process)
             |
   Canonical MpesaTransaction (provisional identity; non-postable)
             |
   UNVERIFIED | CONFLICT | MANUAL_REVIEW
```

G3 remains untouched. C2B + Pull share one inbox and one canonical reconciliation boundary.

## Contract evidence summary

See `docs/provider-contracts/G5_DARAJA_C2B_PULL_EVIDENCE.md`.

| Topic | Classification | Note |
|-------|----------------|------|
| C2B register path v1 vs v2 | BLOCKED/UNKNOWN | Default v1; override via `DARAJA_C2B_REGISTER_PATH` after portal verification |
| Missing `BillRefNumber` on Till | OWNER-DECISION / product rule | Valid; not rejected |
| Confirmation `TransactionType` | PROPOSED | Expect `Buy Goods` / `Buy Goods Online`; not simulator `CommandID` |
| Pull query method POST | SECONDARY (SDK) | Portal docs describe GET; dual path not implemented |
| 48h Pull horizon | SECONDARY | Not treated as guaranteed entitlement |
| TransTime timezone | PROPOSED | Parsed as Africa/Nairobi wall → UTC |
| Canonical receipt uniqueness | BLOCKED/UNKNOWN | Provisional shortcode+receipt index is **not** financial authority (B01/B02) |

## Inbox lifecycle (G5.1)

1. Validate basic structure.
2. **Persist** `MpesaIngestionEvent` (`RECEIVED` or immediate `QUARANTINED`).
3. Acknowledge provider **only after durable persist** (or durable quarantine of malformed body).
4. **Claim** with `processingLeaseToken` / `processingLeaseExpiresAt` → `PROCESSING`.
5. Resolve merchant with exact cardinality (none / exact / ambiguous / suspended).
6. Upsert canonical candidate; complete event with token fence.
7. Recover expired `PROCESSING` via new lease token.

`payloadDigest` is **diagnostic only** (non-unique index). It is not a provider event identity.

## Canonical verification

Matching C2B + Pull channels establishes provider-source consistency only.
`verificationState` remains `UNVERIFIED` until later SMS/Tenant evidence (G5 product rule).
Amount/time mismatch → `CONFLICT`. Ambiguous merchant → quarantine / review.
Source channels updated with `$addToSet`.

`paymentIds[]` is reserved for future multi-Payment relationship; no G3 writes here.
`MpesaTransaction` uses `autoIndex: false` so provisional unique is not installed on boot.

## Pull operations

- Job: `src/jobs/mpesaPull.job.js` via existing `scheduler.js` + Redis `withLock`.
- MongoDB checkpoint lease with fencing token; BUSY when another worker holds a live lease.
- Checkpoint advances only after durable inbox persistence of returned rows (`allPersisted`).
- Empty valid response vs unsupported schema are distinguished (`responseShape`).
- Pagination offset semantics remain BLOCKED without portal unit proof.

## Registration lifecycle

Operator-triggered `registerC2bUrls` / `registerPull` update:

- `c2bRegistrationState` / `pullRegistrationState`
- `REQUESTED` → `ACCEPTED` | `ALREADY_REGISTERED` | `REJECTED` | `UNCERTAIN`
- Timeout → `UNCERTAIN` (not automatic `REJECTED`)

Never auto-register on boot. Never register against production in this task.

## Index / readiness gates

| Gate | Status |
|------|--------|
| Durable inbox operational indexes | Implemented (non-unique) |
| Merchant `{clientId, businessShortCode}` unique | Guarded migration script (dry-run default) |
| Canonical receipt unique | **Blocked** until B01/B02; `autoIndex: false` |
| Pull checkpoint per profile unique | Schema + readiness inspect |

`src/utils/mpesaIndexReadiness.js` exposes separate readiness for inbox, merchant registration, canonical identity, and Pull.

## Explicit non-goals

- SMS / submission links / Tenant claim / G3 posting / PayBill / production Go-Live
