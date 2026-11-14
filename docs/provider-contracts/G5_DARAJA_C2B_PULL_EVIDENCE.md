# G5 — Daraja C2B + Pull Transactions Contract Evidence

**Status:** Evidence record for the G5.3 provider-ingestion slice.
**Prepared:** 2026-11-12
**Scope:** Buy Goods / Till C2B confirmation and Pull Transactions only. No STK, B2C, B2B, PayBill redesign, Tenant attribution, or G3 posting.

## Classification key

| Tag | Meaning |
|-----|---------|
| `VERIFIED-SOURCE` | Confirmed from Safaricom portal FAQ, official endpoint paths repeated across independent technical sources, or direct repository source |
| `SECONDARY` | Consistent third-party / Postman / SDK documentation; not a substitute for portal login verification |
| `OWNER-REPORTED` | Owner-stated merchant fact; not sandbox-proven in this pass |
| `PROPOSED` | Engineering choice pending proof |
| `BLOCKED/UNKNOWN` | Contract detail not established; capability must stay disabled or fail-closed |

## 1. Environments

| Item | Value | Classification | Evidence |
|------|-------|----------------|----------|
| Sandbox base URL | `https://sandbox.safaricom.co.ke` | `SECONDARY` | Repeated across OpenAPI mirrors and integration guides |
| Production base URL | `https://api.safaricom.co.ke` | `SECONDARY` | Same |
| OAuth token path | `GET /oauth/v1/generate?grant_type=client_credentials` with HTTP Basic | `SECONDARY` | Universal Daraja pattern |
| Token expiry | Typically ~3599 seconds | `SECONDARY` | Treat as advisory; refresh with safety margin |

## 2. C2B URL registration

| Item | Value | Classification |
|------|-------|----------------|
| Register endpoint | `POST /mpesa/c2b/v1/registerurl` (v2 appears in tutorials) | `BLOCKED/UNKNOWN` for exact app-enabled version |
| Body fields | `ShortCode`, `ResponseType` (`Completed`\|`Cancelled`), `ConfirmationURL`, `ValidationURL` | `SECONDARY` |
| ResponseType policy | Prefer `Completed` so Till payments are not cancelled when validation is unused | `PROPOSED` |
| Validation optional | External validation is not assumed enabled | `OWNER-REPORTED` / product rule |

## 3. C2B confirmation callback

| Item | Value | Classification |
|------|-------|----------------|
| Typical fields | `TransactionType`, `TransID`, `TransTime`, `TransAmount`, `BusinessShortCode`, `BillRefNumber`, `MSISDN`, names | `SECONDARY` |
| Missing `BillRefNumber` | Valid for Buy Goods / Till | `OWNER-DECISION` / product rule |
| `TransactionType` vs simulator `CommandID` | Confirmation uses values such as `Buy Goods`; simulator may send `CustomerBuyGoodsOnline` | `PROPOSED` |
| Ack body | `{ ResultCode: 0, ResultDesc: 'Accepted' }` after durable persist | `SECONDARY` pattern |
| Cryptographic signature | Not verified in this pass; callbacks treated as untrusted | `BLOCKED/UNKNOWN` |
| TransTime timezone | Parsed as Africa/Nairobi wall → UTC | `PROPOSED` business convention |

## 4. Pull Transactions

| Item | Value | Classification |
|------|-------|----------------|
| Register | `POST /pulltransactions/v1/register` | `SECONDARY` |
| Query method | Implementation uses **POST** `/pulltransactions/v1/query` | `SECONDARY` (SDK); portal GET remains discrepancy |
| Pagination | `OffSetValue` present; page unit unproven | `BLOCKED/UNKNOWN` |
| 48-hour horizon | Documented in secondary sources | `SECONDARY` — not entitlement proof |
| Sync vs async results | Both query response and registered callback paths wired; which is authoritative for this Till is unproven | `BLOCKED/UNKNOWN` |

## 5. Identity and readiness

| Item | Value | Classification |
|------|-------|----------------|
| Canonical key | Provisional `{ provider, businessShortCode, receiptNumber }` | `PROPOSED` — **not** B01/B02 final |
| G3 posting | Disabled while identity gate unresolved | Safety rule |
| C2B+Pull agreement alone | Does **not** set `MATCHED` | G5 product rule |
| Credential storage (B09) | Sandbox env vars only in this slice | `BLOCKED/UNKNOWN` for multi-tenant production |

## 6. Explicit non-claims

- No claim that portal login verified v1 vs v2 C2B registration for this merchant app.
- No claim that Pull GET or POST is the sole correct query method without portal confirmation.
- No claim that 48 hours is a guaranteed retrieval entitlement.
- No claim that TransTime timezone is a Safaricom-documented guarantee.
- No claim of production readiness or financial posting authority.
