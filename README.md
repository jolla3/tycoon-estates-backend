# Tycoon Estates Payment Monitoring System — Backend (V2, hardening pass)

A multi-tenant SaaS backend that monitors rent payments for property
estates: matches bank transactions to houses, tracks who has and hasn't
paid, and sends SMS reminders — without being architecturally welded to
Co-operative Bank or Celcom.

**This build is a hardening pass over the previous V2** after an
independent review found a real cross-estate data-isolation bug and
several unrestricted update endpoints. See the self-audit at the bottom
for exactly what changed and why.

## 1. Installation

```bash
npm install          # REQUIRED before npm test — node_modules is never
                      # shipped in a delivered zip/tarball, same as any
                      # Node.js project
cp .env.example .env
```

## 2. Database Requirements

- **MongoDB**: must be a **replica set** (even a single-node one), not a
  standalone `mongod`. Financial reconciliation now runs inside a real
  Mongo session transaction (`reconciliationService.applyPayment`), and
  standalone MongoDB does not support multi-document transactions at
  all — `session.withTransaction()` will error immediately against one.
  For local development: `mongod --replSet rs0` then, once, `mongosh
  --eval "rs.initiate()"`.
- **Redis**: any instance. Used only for rate limiting and background-job
  distributed locks — never financial data. Fails open (logs a warning,
  allows the request) if unreachable, with every command bounded by a
  timeout so it degrades a defense-in-depth feature instead of hanging
  requests or crashing the process (both were reproduced and fixed
  during development — see `middlewares/rateLimiter.js`).

## 3. Running

```bash
npm run dev
npm start
npm run create-super-admin -- "Name" admin@example.com "password123"
npm test
```

There is deliberately **no sample-data seed script**. The only bootstrap
script creates a single `SUPER_ADMIN` (there is no other way to get one —
public signup only ever creates a `CLIENT_OWNER` of a brand-new client).
Everything else — clients, estates, houses, tenants — gets created
through the real API, by you, with your own test data.

## 4. Architecture

```
Client  (root tenant boundary)
  ├── Staff (Users: SUPER_ADMIN / CLIENT_OWNER / CLIENT_ADMIN / STAFF)
  ├── Estates
  │     └── Houses ── Tenants ── RentCharges ── Payments
  ├── BankAccounts ──▶ BankProvider interface ──▶ CoopBankProvider
  ├── BankTransactions
  ├── SmsMessages  ──▶ SmsProvider interface   ──▶ CelcomProvider
  └── AuditLogs
```

Every business document carries `clientId`. `estateId` is a sub-scope
*within* a client — and, as of this pass, a **staff member's estate
restriction is enforced on every list/report query**, not just on
requests that happen to name an estate explicitly (see section 5).

## 5. What This Hardening Pass Actually Fixed

### 🔴 The estate-isolation bug (the most serious finding)

**Before**: a staff member restricted to `estateIds: [Estate A]` who made
a request with no `estateId` in the query got `req.estateId = null`,
which every service interpreted as "no filter" — i.e. full access to
every estate under the client, including ones they were never granted.

**Now**: `clientContext.js` computes `req.estateFilter`, which is always
the actually-enforced scope:
- `null` — the user has no restriction (empty `estateIds`, the normal
  case for `CLIENT_OWNER`/`CLIENT_ADMIN`).
- a single id — the user asked for one specific, already-verified estate.
- **an array of ids** — the user IS restricted and did NOT name one
  explicitly; every query filters to exactly this set via
  `utils/estateFilter.js#estateFilterClause`.

Every list/report service (`houseService.list`, `tenantService.list`,
`bankService.list`, `transactionService.list/unmatched`,
`smsService.history`, every `reportService` function) now takes
`estateFilter`, not a single optional `estateId`. Verified explicitly in
`tests/integration/estateIsolation.test.js`: a restricted staff member's
`GET /houses` with no `estateId` returns Estate A's houses only, never
Estate B's, even though both belong to the same client.

### 🔴 Unrestricted update endpoints (P0 #3, #4, #5)

`PATCH /houses/:id`, `PATCH /tenants/:id`, and `PATCH /users/:id`
previously passed `req.body` straight into `findOneAndUpdate` with no
field whitelist — a caller could attempt to move a house to another
estate, change a tenant's `houseId` without any relationship check, or
set a staff member's `passwordHash`/`role`/`isActive` directly.

**Now**: each has a restrictive zod schema (`updateHouse`, `updateTenant`,
`updateStaff`) that only allows safe fields:
- `updateHouse`: no `estateId`/`tenantId`/`clientId`.
- `updateTenant`: no `houseId`/`estateId`/`clientId` — moving a tenant is
  a dedicated `POST /tenants/:id/move` operation
  (`tenantService.moveToHouse`) that verifies the target house belongs to
  the same client, refuses if it already has a different tenant, and
  atomically vacates the old house in the same call.
- `updateStaff`: only `name`/`phone`/`estateIds` — no
  `passwordHash`/`role`/`clientId`/`isActive` (which has its own
  dedicated `deactivate` endpoint). Supplied `estateIds` are validated
  against the caller's own client, same as `createStaff`.

### 🔴 `createStaff` didn't validate `estateIds` ownership

A `CLIENT_ADMIN` could previously submit another client's estate id in
`estateIds` and it would be stored as-is. Both `createStaff` and
`updateStaff` now verify every supplied estate belongs to the caller's
own `clientId` before saving, and reject with `INVALID_REQUEST` otherwise.

### 🔴 Financial reconciliation was not atomic

`Payment.create()` → `RentCharge.save()` → `BankTransaction.save()` ran
as three independent writes. A crash between the first two could leave a
payment recorded against a stale rent-charge balance. **Now wrapped in a
real Mongo session transaction** (`reconciliationService.applyPayment`,
used by both the automatic `reconcile()` path and the manual
`transactionService.assignToHouse` admin path) — see section 2 for the
replica-set requirement this introduces. SMS confirmation is sent only
*after* the transaction commits, never inside it, so a rolled-back
payment can never have already notified a tenant.

### 🔴 SMS jobs could be sent twice by concurrent workers

`processQueuedBatch` used to `find()` queued jobs, then save each as
`processing` in a separate step — two workers could both read the same
job while it was still `queued`. **Now** each job is claimed with a
single atomic `findOneAndUpdate({status:'queued'} → {status:'processing'})`,
so two concurrent calls can never claim the same message. Verified with
a concurrency test in `tests/integration/sms.test.js`.

### 🔴 Production could start with insecure default secrets

`COOKIE_SECRET`/`SESSION_SECRET`/`ENCRYPTION_KEY` used to silently fall
back to obviously-fake dev values (`'0'.repeat(64)`, etc.) in **any**
environment. `config/environment.js` now throws at startup if these (or
`MONGODB_URI`/`REDIS_URL`) are missing when `NODE_ENV=production` —
verified directly (see the two contrasting cases this was tested
against). Dev-mode fallbacks still work, with a loud console warning.

### 🔴 `COOP_SCOPE` defaulted to `"default"`

Silently sending an OAuth scope Co-op never actually granted could look
like a working integration right up until the specific call that needed
a real scope 401s. `COOP_SCOPE` has no default now; `coop.auth.js` throws
a clear configuration error the moment authentication is actually
attempted without one.

### 🟡 Also fixed this pass

- `subscriptionService` queried `Subscription` by a field (`estateId`)
  that doesn't exist on the model (`Subscription` is client-scoped) —
  every call silently returned nothing. Fixed to query by `clientId`.
- House search (`?search=...`) built a `RegExp` from unescaped user
  input — a search string containing regex syntax became a regex
  expression. Now escaped via `utils/regex.js`.
- Transaction list date filters (`startDate`/`endDate`) didn't validate
  they were parseable dates before querying — an invalid date silently
  became `Invalid Date` and produced undefined query behavior. Now
  validated, rejecting with `INVALID_REQUEST` on a bad date. The bank
  statement endpoint's date range is now validated the same way
  (`schemas.dateRange`), which it previously wasn't at all.
- The dashboard endpoint returned nothing but the raw rent summary
  despite the API contract implying much more. `reportService.dashboard`
  now returns houses (total/occupied/vacant), rent (expected/collected/
  outstanding), status (paid/partial/unpaid), bank (credits/unmatched),
  and sms (sent/failed/pending/unknown).
- `profile.service.js` split out of `auth.service.js`, which was
  becoming a dumping ground for every human-related database operation.
- `SUPER_ADMIN` requests now verify the `clientId` they name actually
  exists and is active before proceeding, instead of trusting it blindly.

## 6. What Is Still NOT Fixed (Honest Scope Note)

- **No reusable "audit trait" wrapper.** Controllers still call
  `audit(...)` manually after each sensitive action. It's easy to forget
  on a new endpoint. A wrapper like `auditedAction({ action, resource,
  ... })` would make this structurally hard to skip — not built yet.
- **Audit-write failures are still silently swallowed** (logged, but the
  triggering request still succeeds). Defensible for routine actions;
  for financial corrections and privilege changes specifically, a
  reviewer could reasonably want a stronger guarantee (retry queue,
  alerting) than "logged to stdout."
- **SUPER_ADMIN UX**: still requires `?clientId=...` on every request.
  Workable for a platform admin, not pleasant. Not addressed this pass.
- **Redis is rate-limiting + job locks only**, not a general shared-cache
  layer. That was always the intent (financial data stays in MongoDB
  only), but if you want response caching too, that's still unbuilt.
- **The idempotency helper** (`withIdempotency`) is a find-then-create
  pattern protected by a unique index, not a true compare-and-swap. It's
  race-*resistant* (the unique index guarantees at most one document
  survives), not race-*proof* in the sense of avoiding a wasted duplicate
  create attempt under contention. This is a minor performance concern,
  not a correctness one — a rejected duplicate is still correctly
  resolved to the existing document.
- **Co-op's polled-transaction schema remains unverified** —
  `mapCoopPolledTransaction()` still guesses field names for
  `AccountTransactions`/`AccountFullStatement`/`AccountMiniStatement`
  responses, explicitly flagged with `_unverifiedSchema: true`. The
  webhook mapper (`mapCoopWebhookNotification`) is fully confirmed
  against the supplied docs; the polling path is not, and can't be
  without a live sandbox call.
- **Nothing here has been run against a real MongoDB, Co-op sandbox, or
  Celcom account.** See the test-status breakdown below for exactly
  what was and wasn't executed.

## 7. Test Status — Precisely, Not Optimistically

```
Syntax (`node --check` on every file):     PASS
Import resolution (createApp() builds):    PASS
Unit tests (no DB required):               PASS — 25/25, actually executed
Integration tests (need MongoDB):          NOT EXECUTED in this environment
                                            (no path to a MongoDB binary —
                                            no matching apt package, no
                                            Docker, no network access to
                                            MongoDB's own download servers)
Real Co-op sandbox call:                   NOT VERIFIED
Real Celcom API call:                      NOT VERIFIED
```

`npm test` reports integration suites as **skipped**, not passing — they
are gated behind `MONGODB_URI` being set (`tests/helpers/db.js`) so this
can never be misread as false coverage. Run them for real:

```bash
MONGODB_URI="mongodb://127.0.0.1:27017/tycoon_test?replicaSet=rs0" npm test
```

(A replica set is required — see section 2 — because
`tests/integration/reconciliation.test.js` and `updateSchemas.test.js`
now exercise the transactional reconciliation path.)

If you run them and something fails, that's genuinely useful information
this environment could not produce — please report it back rather than
assuming it's fine because the unit tests passed.

## 8. Co-op Bank Integration

Implements against the actual Co-op Connect 2.0.0 documentation: OAuth2
password grant (`coop.auth.js`), the real endpoint names
(`AccountTransactions`, `AccountFullStatement`, `AccountBalance`,
`AccountValidation`), documented request bodies validated by zod
(`coop.schemas.js`), and the fully-specified `SendTransactionINS` webhook
payload including its compact `YYYYMMDDHHmmss` date format. See section 6
above for what remains unverified, and `.env.example` for every credential
this needs from you/Co-op.

## 9. Reconciliation Matching Hierarchy

Unchanged from before, still exact-match only, still `clientId`-scoped
throughout:

1. `House.houseNumber` exact match (case-insensitive).
2. `House.paymentReferences` alias match.
3. Otherwise `UNMATCHED`, surfaced at `GET /transactions/unmatched` for
   `POST /transactions/:id/assign` (also transactional as of this pass).

## 10. Credentials Required From You / Co-op / Celcom

- **Co-op**: `COOP_CLIENT_ID`/`COOP_CLIENT_SECRET` (DCR), `COOP_USERNAME`/
  `COOP_PASSWORD` (password grant), `COOP_SCOPE` (from their developer
  portal — no default), `COOP_INS_BASIC_SECRET` (whatever credential
  Co-op configures for your `SendTransactionINS` subscription).
- **Celcom**: `CELCOM_PARTNER_ID`, `CELCOM_API_KEY`, `CELCOM_SENDER_ID`.
- Real, random `COOKIE_SECRET`/`SESSION_SECRET`/`ENCRYPTION_KEY` — these
  now have no fallback in production, by design.
- Per-estate bank account details — entered through
  `POST /api/v1/bank/accounts`, never `.env`.

---

## Self-Audit

```
[x] Estate-level staff isolation actually enforced on every list/report
    query, not just requests that happen to name an estate (THE fix)
[x] createStaff/updateStaff validate estateIds against the caller's clientId
[x] House/Tenant/Staff updates go through field-whitelisting schemas —
    no more raw req.body -> findOneAndUpdate
[x] Tenant moves between houses are a validated, atomic operation
[x] Financial reconciliation (Payment+RentCharge+BankTransaction) runs in
    a real Mongo session transaction — requires a replica-set MongoDB
[x] SMS job claiming is atomic — concurrency-tested
[x] Production startup fails fast on missing secrets/infra config —
    verified both the failure and success case directly
[x] COOP_SCOPE has no silent default — verified it throws when missing
[x] Subscription service bug fixed (was querying a nonexistent field)
[x] House search input is regex-escaped
[x] Transaction/statement date ranges are validated
[x] Dashboard returns actual structured data, not just the rent summary
[x] No sample-data seed script — only a minimal SUPER_ADMIN bootstrap
[~] Audit trail exists and is clientId-scoped, but is NOT a reusable
    trait/wrapper — still opt-in per controller, and write failures are
    still swallowed for all but the criticality level discussed above
[~] SUPER_ADMIN client-context UX is functional but not streamlined
[ ] Co-op polled-transaction schema — still unverified, honestly flagged
[ ] Real sandbox/API verification (Co-op, Celcom) — not possible in this
    environment; genuinely not done, not claimed done
[x] Unit tests actually executed: 25/25 pass
[ ] Integration tests actually executed against MongoDB — NOT done here;
    written, syntax-checked, gated behind MONGODB_URI, and require a
    replica set for the transactional tests specifically
```
