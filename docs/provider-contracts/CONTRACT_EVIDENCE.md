# G4 Provider Contract Evidence

Last updated: 2026-11-11 (correction pass)

## COOP — AccountFullStatement (supplied OpenAPI)

**API:** AccountFullStatement  
**Version:** 1.0.0  
**Operation:** `POST /`  
**Server (sandbox):** `https://openapi-sandbox.co-opbank.co.ke/Enquiry/FullStatement/Account/1.0.0`

### Verified by supplied FullStatement specification

| Topic | Evidence |
|-------|----------|
| Request fields | `MessageReference`, `AccountNumber`, `StartDate`, `EndDate` |
| Success response envelope | Requires `MessageCode`, `MessageDateTime`, `MessageDescription`, `MessageReference` |
| Transactions array | `Transactions` referencing AccountTransaction items |
| Item fields | `TransactionId`, `TransactionDate`, `ValueDate`, `Narration`, `TransactionType`, `ServicePoint`, `TransactionReference`, `CreditAmount`, `DebitAmount`, `RunningClearedBalance`, `RunningBookBalance`, `DebitLimit`, `LimitExpiryDate` |
| Direction | `TransactionType` described as **C** = Credit, **D** = Debit; amounts also present as CreditAmount/DebitAmount |
| Dates | `TransactionDate` and `ValueDate` are separate properties |
| Auth expectation | OAuth2/Bearer on the API channel (not token lifecycle detail) |

### Schema inconsistencies / limits (documented)

- `AccountNumber` min/max length **14** while an example value may contain **11** digits — treat length rules as schema-declared; do not invent alternate formats.
- Individual transaction properties are **not** marked required in the supplied schema.
- No **currency** field on the transaction item schema.
- `TransactionId` described as unique; **uniqueness scope is not defined** (account vs bank-wide vs connection).

### Still unverified (behavior / operations)

| Topic | Status |
|-------|--------|
| Live sandbox response fixtures matching schema | Not demonstrated in this workspace |
| OAuth grant type, customer scopes, token TTL, refresh | Not established by FullStatement OpenAPI alone |
| Runtime guarantees for missing fields / contradictory amounts | Not verified against sandbox |
| Currency behavior for FullStatement items | Not in schema |
| **Separate** AccountTransactions **list** API operation item schema & polling semantics | **Not** verified by FullStatement component reuse — list polling remains **disabled** |
| Callback retry / HTTP acknowledgement contract | Not established |
| INS inbound Basic credential scope | See below |

### INS inbound authentication scope

Co-op SendTransactionINS materials describe a **Basic Auth Endpoint Credential** as the callback-channel credential. Available project evidence supports treating this as an **application-level integration credential** (platform `COOP_INS_BASIC_SECRET`), not as per-customer outbound OAuth secrets stored on `BankConnection`.

Outbound Co-op API credentials remain connection-scoped via the secrets manager.

If future official Co-op documentation requires per-subscription INS secrets, the webhook verifier must be extended; until then, inventing per-connection INS secrets is not justified.

## KCB / EQUITY / NCBA

No project-owned verified OpenAPI for G4 rent-monitoring account feeds. Adapters remain disabled shells (fail closed).

## Implementation mapping

- FullStatement date-window sync uses documented request shape; direction mapping uses amounts and C/D `TransactionType`.
- AccountTransactions **list polling remains disabled**.
- Webhook exposure requires operational readiness or explicit lab override.
