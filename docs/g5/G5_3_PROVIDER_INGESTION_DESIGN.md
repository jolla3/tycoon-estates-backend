# G5.3 — Daraja Provider Ingestion Design (Buy Goods / Till)

**Status:** Implemented in code on `feature/g5-construction` (sandbox-first).  
**Does not authorize:** Tenant attribution, SMS links, G3 Payment posting, production registration, or live financial ops.

## Boundary

Provider verification only:

```
OAuth → C2B register (operator) → C2B confirm callback
OAuth → Pull register (operator) → Pull query / Pull result callback
        ↓
  MpesaIngestionEvent (durable raw observation)
        ↓
  MpesaTransaction (canonical receipt, provisional unique key)
```

G3 remains untouched.

## Contract evidence

See `docs/provider-contracts/G5_DARAJA_C2B_PULL_EVIDENCE.md`.

Key points:

- C2B missing `BillRefNumber` is valid for Till.
- External validation is not assumed enabled.
- Callbacks are untrusted (no verified cryptographic signature).
- Pull query is POST with offset pagination; 48h window is secondary evidence.
- Pull sync vs callback-only response remains partially BLOCKED/UNKNOWN; both paths are wired.
- Receipt uniqueness uses provisional `{ provider, businessShortCode, receiptNumber }` — not a final B01/B02 proof.

## Models

| Model | Role |
|-------|------|
| `MpesaMerchantProfile` | Shortcode ownership + registration state flags |
| `MpesaIngestionEvent` | Immutable-ish ingress + quarantine (`mpesaingestionevents`) |
| `MpesaTransaction` | Canonical receipt (`mpesatransactions`) |
| `MpesaPullCheckpoint` | Per-profile Pull window/lease |

No `MpesaPaymentClaim`. No G3 writes.

## Routes

Mounted under `/api/v1/webhooks` (no CSRF), keyword-safe paths:

- `POST /daraja/c2b/confirm`
- `POST /daraja/c2b/validate`
- `POST /daraja/pull/results`

Exposure requires `DARAJA_CALLBACKS_ENABLED=1` (or non-prod `DARAJA_CALLBACKS_LAB=1`).

## Env

```
DARAJA_ENVIRONMENT=sandbox|production
DARAJA_CONSUMER_KEY=
DARAJA_CONSUMER_SECRET=
DARAJA_CALLBACKS_ENABLED=0
DARAJA_CALLBACKS_LAB=0
```

## Idempotency

1. Ingestion event unique on `{ provider, businessShortCode, sourceChannel, payloadDigest }`.
2. Canonical txn unique on `{ provider, businessShortCode, receiptNumber }`.
3. Conflicting amount/time → `verificationState=CONFLICT`, event quarantined; no silent overwrite.
4. C2B + Pull same receipt → one canonical row; `sourceChannels` accumulates.

## Explicit non-goals in this slice

- SMS submission / link lifecycle (G5.2)
- Tenant claim / G3 posting
- Auto-register on boot
- Production Go-Live

## Acceptance for sandbox milestone

- Unit tests for OAuth cache/coalesce, normalize, Pull extract.
- Code paths for register/query exist and are operator-gated.
- Live sandbox API success is **optional** and reported separately when credentials exist.
