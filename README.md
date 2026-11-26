# Tycoon Estates Backend

The Node.js API and background-processing service for the Tycoon Estates property-management platform. It provides the authenticated business API used by the frontend, stores the platform's client/estate, tenancy and financial records, and integrates with external banking, M-PESA and SMS providers.

**Companion web application:** [jolla3/tycoon-frontend](https://github.com/jolla3/tycoon-frontend)

This repository contains multiple domain workstreams. The root `PRD.md` and `architecture.md` are specifically focused on **G4 Banking**; they are not a single all-project product specification. G3 accounting, G5 M-PESA collection and Reports V1 have their own documents under `docs/`.

---

## Product and domain overview

Tycoon Estates is a multi-client property-management system. A client owns one or more estates; estates contain houses; tenants occupy houses through time-bounded Tenancy records. Billing, payments and allocations are tied to the relevant financial and tenancy identities.

### Core domains

| Domain | Responsibility |
|---|---|
| Identity and platform | Users, roles, clients, subscriptions, entitlements and platform administration |
| Estates and property | Estates, houses, house types and configured billing plans |
| Tenancy | Tenant identity and distinct occupancy/tenancy records |
| Billing | Rent charges and configured rent/utility obligations |
| Accounting (G3) | Payments, payment allocations, ledger movements and tenant credit |
| Deposits | Tenancy-specific deposit records and movements |
| Banking (G4) | Bank connections, protected credentials, bank accounts, transaction ingestion and reconciliation workflows |
| M-PESA collection (G5) | Merchant profiles, Daraja ingestion, canonical receipts, tenant submission links, SMS evidence and gated attribution/posting workflows |
| Notifications | SMS messages, templates, protected notification flows and delivery jobs |
| Reporting | Management summaries and domain-specific report endpoints; Reports V1 is documented as a separate read-only expansion |

### Financial source-of-truth boundary

G3 is the financial authority. Banking and M-PESA integrations ingest or observe external transaction evidence; they do not create a parallel ledger.

Keep these concepts separate:

- A provider receipt is an external receipt record.
- An SMS confirmation submitted by a tenant or payer is evidence, not proof of payment.
- A G3 Payment is a financial record created through the authorized posting path.
- PaymentAllocation applies a Payment to specific RentCharge obligations.
- CREDIT-origin applications use existing tenant credit; they are not new cash receipts.
- RentCharge balances are charge projections, not a replacement for the ledger.

A source receipt and its child Payment records must never be counted as multiple copies of the same incoming cash.

---

## Technology stack

- **Node.js 18 or newer**
- **Express 4** for the HTTP API
- **MongoDB / Mongoose 8** for persistent domain records
- **MongoDB-backed sessions** through `connect-mongo`
- **Redis / ioredis** for runtime coordination and supporting infrastructure
- **Zod** for request and configuration validation
- **Pino** for structured logging
- **Jest** for tests and **Supertest** for HTTP-level testing
- **ESLint** for linting
- **Swagger UI** for the generated OpenAPI document

The codebase uses native JavaScript ES modules.

---

## Architecture

### Request flow

```text
Browser / frontend
       |
       v
Express application
  security + CORS + request logging
  session + CSRF + rate limiting
       |
       v
/api/v1 route modules
       |
       v
controllers / services
       |
       +---- MongoDB models and transactions
       |
       +---- Redis coordination
       |
       +---- provider adapters (bank, Daraja, SMS)
       |
       +---- background jobs
```

The HTTP application is assembled in `src/app.js`; process startup and shutdown are handled by `src/server.js`. Route modules are mounted under `/api/v1` by `src/routes/index.js`. Business logic belongs in services, not route assembly.

### Multi-tenant boundaries

- Every business record is scoped to a client.
- Estate scope is a narrower boundary within a client.
- Authenticated user role, selected client and assigned estate scope are resolved on the server.
- Frontend filters are not an authorization mechanism.
- Cross-client or cross-estate relationships must be validated by the backend before writes and reads.

### Financial integrity

- MongoDB replica-set transactions are required for multi-document financial operations.
- Idempotency, unique indexes, conditional updates and claim/fencing controls protect critical ingestion and posting paths.
- Posting must preserve the existing G3 accounting/ledger authority.
- Provider callbacks and Pull observations must converge on canonical receipt identity before any financial effect.
- Unknown, conflicting or unverified provider data must be rejected, quarantined or left for review according to the relevant domain contract. Do not guess missing transaction identity or direction.

### Security

- Authenticated sessions use HttpOnly cookies stored through MongoDB-backed session storage.
- State-changing authenticated API requests are protected by CSRF middleware.
- CORS must allow the exact frontend origin when credentialed cross-origin requests are used.
- Public M-PESA message submission is mounted as a deliberately narrow route outside the authenticated session/CSRF boundary; it does not grant payment approval or posting access.
- Request validation, rate limits, role checks, client/estate scoping and audit records belong on the server.
- Application and provider secrets are supplied through environment configuration or protected credential storage. Never commit real credentials or log raw secrets, tokens, retained SMS evidence or provider payloads unnecessarily.

---

## Integration readiness is gated

The repository contains integration code and lifecycle controls, but code presence is not proof that a provider is configured, verified or production-operational.

### Banking (G4)

The banking domain includes connection-scoped credential records, bank accounts, transaction ingestion, provider adapters, sync coordination and webhook handling. Co-operative Bank is the first adapter path. Provider resource contracts, secrets storage, entitlements and operational readiness must be checked before enabling a specific operation. Reserved or disabled provider adapters must not be advertised as live integrations.

### M-PESA (G5)

The M-PESA domain includes Daraja merchant profiles, canonical provider transactions, C2B/Pull ingestion components, tenant submission links, SMS parsing/evidence review and gated G3 posting paths.

Keep these separate:

1. Merchant registration evidence
2. C2B callback capability
3. Optional Pull recovery capability
4. Provider receipt verification and canonical identity
5. Tenant/estate attribution
6. Authorization to post through G3

A successful registration response or accepted SMS submission is not a verified receipt and is not a posted rent payment. Callback, Pull, submission, retention and posting controls are environment-gated and must remain disabled until their documented verification and owner-approval requirements are satisfied.

### SMS and notifications

SMS templates and dispatch workflows are handled by backend services and jobs. Provider credentials and delivery readiness must be configured and verified separately. Protected messages and payment-link notifications have additional keyring and dispatch gates.

---

## Local development

### Requirements

- Node.js **18 or newer**
- npm
- MongoDB configured as a **replica set** (a single-node replica set is sufficient for local development)
- Redis

MongoDB replica-set support matters: financial operations use multi-document transactions, which a standalone MongoDB server cannot provide. The backend startup also waits for Redis.

### 1. Start local infrastructure

Start a local MongoDB replica set. For an existing local MongoDB installation, the essential configuration is:

```bash
mongod --replSet rs0 --bind_ip localhost
```

Initialize the replica set once:

```bash
mongosh --eval "rs.initiate()"
```

Start Redis separately using your local Redis service.

### 2. Configure the environment

Install dependencies and create a local environment file:

```bash
npm ci
cp .env.example .env
```

Set at least the required local values in `.env`:

```dotenv
NODE_ENV=development
PORT=4000
MONGODB_URI=mongodb://127.0.0.1:27017/tycoon_estates?replicaSet=rs0
REDIS_URL=redis://127.0.0.1:6379
FRONTEND_URL=http://localhost:3000
COOKIE_SECRET=<random-secret>
SESSION_SECRET=<random-secret>
ENCRYPTION_KEY=<64-hex-character-key>
```

Generate separate random values for the secrets. For example, run this command three times and use a different output for each secret:

```bash
openssl rand -hex 32
```

`ENCRYPTION_KEY` must be exactly 64 hexadecimal characters (32 bytes). Keep real values only in your local `.env` or deployment secret store. Do not commit them.

The committed `.env.example` contains placeholders, not usable credentials. Review `src/config/environment.js` and the relevant domain documentation for optional provider-specific settings. Keep provider callbacks, Pull reconciliation, public submissions, protected SMS and M-PESA posting disabled unless their complete readiness gates have been verified and explicitly approved.

### 3. Run the API

```bash
npm run dev
```

The default API port is `4000`.

### 4. Create the first platform administrator

There is intentionally no general sample-data seed. Create a Superadmin explicitly when needed:

```bash
npm run create-super-admin -- "Administrator Name" admin@example.com "A-strong-password"
```

The password must contain at least eight characters. This command creates only the `SUPER_ADMIN` user; it does not create a client, estate, house or tenant. Add business data through the application/API using your own test environment.

---

## API and operational endpoints

| Path | Purpose |
|---|---|
| `/api/v1` | Versioned business API |
| `/api/v1/health` | Liveness probe used by the frontend |
| `/health` | Root liveness probe |
| `/ready` | Dependency readiness: MongoDB, Redis and MongoDB transaction support |
| `/api-docs` | Swagger UI for the generated OpenAPI specification |
| `/api/v1/public/mpesa` | Narrow public M-PESA SMS-submission boundary |
| `/api/v1/webhooks` | Provider webhook routes, including bank and Daraja callback modules |

The main API route groups include authentication, profile, estates, houses, tenants, billing, house types, payments, deposits, bank connections/accounts, transactions, M-PESA collection and receipt history, SMS, reports, users, platform administration and subscriptions.

---

## Commands

| Command | Purpose |
|---|---|
| `npm run dev` | Start with Node's watch mode |
| `npm start` | Run the package's configured start script |
| `npm test` | Run Jest tests serially |
| `npm run lint` | Lint `src`, `tests` and `scripts` |
| `npm run create-super-admin -- "Name" email "password"` | Create a platform Superadmin |

Some integration tests require a MongoDB replica set and supporting local services. Read the test output carefully: skipped tests are not passing tests. Automated tests also do not substitute for provider sandbox verification or production-readiness approval.

---

## Reports V1 status

The current reporting API includes management, monthly, arrears, payments, bank-transaction, SMS and billed-versus-paid routes.

The owner-approved Reports V1 expansion is documented but **not implemented as a complete reporting contract yet**. Its planned sections are Overview, Revenue & Collections, Arrears, Occupancy and M-PESA Collections.

The backend specification is intentionally read-only: it reuses existing G3/G4/G5 sources and does not introduce a second ledger or posting flow.

- [Reports V1 PRD](docs/REPORTS_V1_PRD.md)
- [Reports V1 architecture and API contract](docs/REPORTS_V1_ARCHITECTURE.md)

---

## Repository layout

```text
src/
  app.js                 Express middleware and route assembly
  server.js              Process startup, dependencies and graceful shutdown
  config/                Environment, database, Redis, logging and security
  controllers/           HTTP controller layer
  docs/                  OpenAPI specification
  jobs/                  Scheduled and background work
  middlewares/            Authentication, scope, CSRF, validation and controls
  models/                 Mongoose domain models
  routes/                 Versioned HTTP route modules
  services/               Business logic and provider integrations
  utils/                  Shared domain and infrastructure helpers
scripts/                  Operator/bootstrap scripts
tests/
  unit/                   Unit tests
  integration/             Integration and database-backed tests
```

---

## Project documentation map

| Document | Scope |
|---|---|
| [G3 PRD](docs/g3/PRD.md) | Tenancy-aware accounting and financial foundation |
| [G3 architecture](docs/g3/architecture.md) | G3 data model, ledger and posting design |
| [G4 PRD](PRD.md) | Bank connections and Co-op integration requirements |
| [G4 architecture](architecture.md) | Banking integration architecture |
| [G4 implementation review](docs/G4_FINAL_IMPLEMENTATION_REVIEW.md) | Dated G4 review; check its stated baseline and later refreshes before relying on historical findings |
| [G5 documentation index](docs/g5/README.md) | M-PESA collection, tenancy, evidence, posting and operational design records |
| [G5 provider-contract evidence](docs/provider-contracts/G5_DARAJA_C2B_PULL_EVIDENCE.md) | Daraja contract evidence and unresolved provider gates |
| [Reports V1 PRD](docs/REPORTS_V1_PRD.md) | Approved reporting requirements |
| [Reports V1 architecture](docs/REPORTS_V1_ARCHITECTURE.md) | Reporting aggregation and API design |
| [OpenAPI source](src/docs/openapi.js) | API schema served at `/api-docs` |

Documentation in this repository is organized by domain and milestone. Some files are historical decision records or dated implementation snapshots; always compare their stated baseline/status with the current branch and source before treating them as evidence of what is deployed.

---

## Engineering and release rules

- Read the relevant domain PRD, architecture, short architecture summary and provider evidence before changing a financial or provider workflow.
- Verify the target branch and current GitHub HEAD before implementation.
- Keep changes isolated to the approved workstream; do not mix G3, G4 and G5 changes without an explicit dependency reason.
- Never create a second ledger, wallet or financial posting engine.
- Do not run production migrations, provider calls, callback exposure, live SMS or posting enablement as a side effect of local development.
- Report exact test commands and outcomes. Mark unexecuted, skipped and provider-unverified checks honestly.
