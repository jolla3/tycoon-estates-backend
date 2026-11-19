# G5 — Daraja C2B + Pull Transactions Contract Evidence

## Product-scope correction — 2026-11-19

The provider evidence below was assembled for the earlier G5.3 Buy Goods/Till slice. Its original scope statement is historical and is no longer a product-scope prohibition on PayBill. The product target now includes both `PAYBILL` and `BUY_GOODS_TILL`, with one shortcode merchant profile mapped to multiple same-client estates.

This correction does **not** upgrade any provider evidence classification. In particular:

- The existing owner-supplied C2B evidence records `Pay Bill` as a callback transaction type and identifies `BillRefNumber` as an optional callback field. That establishes a normalization/routing requirement, not a complete PayBill rent-allocation implementation.
- The reviewed Safaricom C2B documentation describes Register URL as mapping confirmation/validation URLs to a shortcode and says external validation is optional and must be enabled for the shortcode. Tycoon should own shared platform callback URLs and register them against each merchant shortcode; clients do not need separate callback servers.
- Safaricom's public C2B reference document is available at [Safaricom M-PESA Integration API overview](https://www.safaricom.co.ke/images/Downloads/Tender_Documents/EOI_Safaricom_M-PESA_Integration_V1_002.pdf). The current Daraja API directory is [Safaricom Developers Portal](https://developer.safaricom.co.ke/apis). Re-check the authenticated Daraja portal's current merchant-specific contract before implementation/production registration.
- The current `handleC2bValidation` implementation accepts every request. This is not evidence that validation is implemented safely. External validation must remain disabled until shortcode activation, reference validation, callback trust, acknowledgement timing and failure behavior are proven.
- The current source Pull registration contract requires `shortCode`, `nominatedNumber` and `callBackUrl`. The nominated number is a merchant-specific KYC value; the callback URL is Tycoon platform configuration. Protect the nominated number and record the callback-config version/snapshot.
- Callback authentication has not been established by the evidence collected for this repository. A shortcode in an inbound body is not authentication. Public callback processing and automated G3 posting remain gated until authenticity/abuse controls are evidenced.

For PayBill allocation, treat `BillRefNumber` as an optional provider value. Tycoon must resolve it against an explicit, unique merchant collection-reference mapping to exactly one tenant + estate. Missing, unknown, retired or ambiguous references remain unallocated. Do not attribute every receipt from a shared PayBill to every estate mapped to that merchant. The existing Till workflow retains tenant SMS/link evidence and active merchant-estate mapping checks.

The target data-model proposal and migration/receipt-visibility rules are in the authoritative correction section at the top of `docs/superadmin/TYCOON_SUPERADMIN_CURRENT_BACKEND_MAP.md` and in the frontend `architecture.md`. They are target architecture only; current code remains Till-only with one estateId.


**Updated:** 2026-11-14
**Scope:** Buy Goods / Till C2B confirmation and Pull Transactions only. No STK, B2C, B2B, PayBill redesign, Tenant attribution, or G3 posting.

## Classification key

| Tag | Meaning |
|---|---|
| `PORTAL-DOCS-OWNER-SUPPLIED` | Exact documentation text copied by the owner from the authenticated Daraja developer portal during this work. It is primary-provider evidence supplied by the owner, not independently fetched by this session. |
| `SANDBOX-EXECUTED-OWNER-REPORTED` | Request and response executed by the owner in the Daraja portal/UI and supplied in this conversation. |
| `SOURCE-VERIFIED` | Confirmed directly in the current repository source. |
| `OWNER-REPORTED` | Merchant or environment fact reported by the owner. |
| `PROPOSED` | Engineering choice pending additional evidence. |
| `BLOCKED/UNKNOWN` | Contract or merchant capability not established; keep gated or fail closed. |

## 1. Evidence provenance and observed environment

- Repository source baseline for this correction: `main` at `5a96f124f45b7f556fc467eb65dbf1bc87413f88` (`2026-11-14`). `SOURCE-VERIFIED`.
- Daraja sandbox Consumer Key/Secret successfully acquired an OAuth access token from the owner's laptop and from the deployed Render runtime. Tokens and credentials were not disclosed in logs. `SANDBOX-EXECUTED-OWNER-REPORTED`.
- The general Tycoon Estates sandbox app credential card showed Short Code `174379`. `OWNER-REPORTED`.
- The C2B `registerURL` invocation form for the same selected app auto-populated Short Code `600987`. The owner invoked C2B v2 using `600987`; Daraja returned `ResponseCode: "00000000"`, `ResponseDescription: "Success"`, and an Originator Conversation ID. `SANDBOX-EXECUTED-OWNER-REPORTED`.
- These two shortcode values are recorded separately. Their merchant/product relationship is **not inferred**. B01/B03 remain open until the exact shortcode/Till mapping and Pull eligibility are established.
- The registered sandbox callback URLs point to the Render service. The deployed callback feature gate currently returns `503 Not exposed`; no callback simulation has been run and no callback payload has been processed.

## 2. Environments and OAuth

| Item | Value | Classification |
|---|---|---|
| Sandbox base URL | `https://sandbox.safaricom.co.ke` | `PORTAL-DOCS-OWNER-SUPPLIED` |
| Production base URL | `https://api.safaricom.co.ke` | `PORTAL-DOCS-OWNER-SUPPLIED` |
| OAuth | `GET /oauth/v1/generate?grant_type=client_credentials`, HTTP Basic | `PORTAL-DOCS-OWNER-SUPPLIED` + `SANDBOX-EXECUTED-OWNER-REPORTED` |
| Token lifetime | Approximately one hour | `PORTAL-DOCS-OWNER-SUPPLIED`; client refreshes with a safety margin |

## 3. C2B URL registration and callback

| Item | Value | Classification |
|---|---|---|
| Register URL | `POST /mpesa/c2b/v2/registerurl` | `PORTAL-DOCS-OWNER-SUPPLIED` + successful sandbox invocation |
| Simulate | `POST /mpesa/c2b/v2/simulate` | `PORTAL-DOCS-OWNER-SUPPLIED` |
| Request fields | `ShortCode`, `ResponseType` (`Completed` or `Cancelled`), `ConfirmationURL`, `ValidationURL` | `PORTAL-DOCS-OWNER-SUPPLIED` |
| Success response | `ResponseCode: "00000000"`, `ResponseDescription: "Success"` observed for shortcode `600987` | `SANDBOX-EXECUTED-OWNER-REPORTED` |
| Callback transaction fields | `TransactionType`, `TransID`, `TransTime`, `TransAmount`, `BusinessShortCode`, `BillRefNumber`, `MSISDN`, names and balance/reference fields | `PORTAL-DOCS-OWNER-SUPPLIED` |
| C2B transaction type labels | `Buy Goods` or `Pay Bill` | `PORTAL-DOCS-OWNER-SUPPLIED` |
| v2 MSISDN | Masked representation | `PORTAL-DOCS-OWNER-SUPPLIED` |
| Validation activation | Optional; requires Safaricom enablement request | `PORTAL-DOCS-OWNER-SUPPLIED`; not established for this merchant |
| Callback authentication | No cryptographic signature or authentication method established by the supplied excerpt | `BLOCKED/UNKNOWN` |
| Callback acknowledgement/retry semantics | Accept/reject response described for validation; confirmation delivery/retry contract still needs exact app/merchant verification | `BLOCKED/UNKNOWN` |

**Implementation correction:** C2B v2 is now the default registration/simulation path. The callback's `TransactionType: "Buy Goods"` is normalized to the canonical internal `CustomerBuyGoodsOnline` value expected by the posting evidence check. `Pay Bill` is normalized to `CustomerPayBillOnline` and quarantined because PayBill is outside G5 scope.

## 4. TransactionPull registration

| Item | Value | Classification |
|---|---|---|
| Register | `POST /pulltransactions/v1/register` | `PORTAL-DOCS-OWNER-SUPPLIED` |
| Request fields | `ShortCode`, `RequestType: "Pull"`, `NominatedNumber`, `CallBackURL` | `PORTAL-DOCS-OWNER-SUPPLIED` |
| Success response | `ResponseStatus: "1000"` | `PORTAL-DOCS-OWNER-SUPPLIED` |
| Already registered | `ResponseStatus: "1001"` | `PORTAL-DOCS-OWNER-SUPPLIED` |
| Registration cardinality | One-time registration | `PORTAL-DOCS-OWNER-SUPPLIED` |
| Shortcode eligibility | The supplied text says the shortcode must belong to a user live and operating in production; sandbox registration eligibility is not demonstrated | `PORTAL-DOCS-OWNER-SUPPLIED` / `BLOCKED/UNKNOWN` for this sandbox |
| Nominated number | Safaricom MSISDN on the shortcode KYC details | `PORTAL-DOCS-OWNER-SUPPLIED`; actual value not yet verified |
| Registration execution | No Pull registration request has been sent | `BLOCKED/UNKNOWN` |

## 5. TransactionPull query and response

| Item | Value | Classification |
|---|---|---|
| Query | `POST /pulltransactions/v1/query` | `PORTAL-DOCS-OWNER-SUPPLIED` |
| Request fields | `ShortCode`, `StartDate`, `EndDate`, `OffSetValue` | `PORTAL-DOCS-OWNER-SUPPLIED` |
| Success response | `ResponseCode: "1000"`, `ResponseMessage`, `Response` | `PORTAL-DOCS-OWNER-SUPPLIED` |
| No transactions | `ResponseCode: "1001"` | `PORTAL-DOCS-OWNER-SUPPLIED` |
| Nested response example | `Response: [[{ transactionId, trxDate, msisdn, transactiontype, billreference, amount, organizationname }]]` | `PORTAL-DOCS-OWNER-SUPPLIED` |
| Timestamp example | ISO-8601 UTC, e.g. `2020-08-05T10:13:00Z` | `PORTAL-DOCS-OWNER-SUPPLIED` |
| Recovery horizon | Last 48 hours | `PORTAL-DOCS-OWNER-SUPPLIED`; operational entitlement and actual merchant retention still require verification |
| Offset semantics | Described as record offset; actual page size, terminal-page indication and complete pagination sequence not demonstrated | `PORTAL-DOCS-OWNER-SUPPLIED` / `BLOCKED/UNKNOWN` |

**Implementation correction:** the parser now flattens documented nested row arrays, maps documented lower-case field names, parses timezone-explicit ISO timestamps, and supplies the shortcode from the merchant profile used for the query because the documented row example omits it. A conflicting row shortcode is quarantined. Query code already uses POST and is covered by a request-contract test.

**Buy Goods safety:** the supplied sample `transactiontype: "c2b-pay-bill-debit"` describes a PayBill transaction. It is normalized as `CustomerPayBillOnline` and rejected from G5 Buy Goods processing. No unverified Pull transaction-type string is guessed to mean Buy Goods; an unknown type is quarantined until an actual sanitized Buy Goods Pull fixture establishes it.

## 6. Readiness and remaining gates

- C2B v2 URL registration was accepted by the sandbox for shortcode `600987`; this does not prove that `174379` and `600987` are the same merchant identity or establish the real production Till mapping. B01/B03 remain open.
- Callback URLs are registered in sandbox, but the Render callbacks remain intentionally not exposed. Do not enable `DARAJA_CALLBACKS_ENABLED` until provider callback authentication/abuse controls and database-ingress safeguards are resolved.
- Pull query method and documented response envelope are now represented in code/tests, but no Pull query or Pull registration request has been executed for this merchant.
- Pull registration eligibility, nominated number, Buy Goods Pull transaction-type fixture, pagination terminal semantics and full 48-hour entitlement remain unverified.
- The exact canonical receipt identity and its unique index remain gated by B01/B02. G3 posting remains disabled.
- No callback simulation, Pull registration, Pull query, production API request, migration, or G3 payment posting was performed as part of this correction.
