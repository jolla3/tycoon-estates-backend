# G5 construction workspace

This directory is the **G5 construction workspace** for Tycoon Estates backend.

## Documents (read in order)

1. `architecture-summary.md` — short context and current gate.
2. `PRD.md` — product behaviour, acceptance criteria and owner decisions.
3. `architecture.md` — repository audit, domain design, routes, jobs, indexes and tests.
4. `G5_1_SCHEMA_INDEX_DESIGN.md` — provisional five-record schema and index design.
5. `G5_2_TENANCY_LINK_AND_OUTBOX_DESIGN.md` — tenancy lifecycle, protected SMS outbox and independent-review resolution.
6. `G5_IMPLEMENTATION_GUARDRAILS.md` — mandatory agent conduct, source verification and no-guessing rules.
7. `G5_SOURCE_HEAD.txt` — pinned application-source audit baseline, not feature-branch HEAD.

## Source baseline

- Repository: `https://github.com/jolla3/tycoon-estates-backend`
- Branch: `main`
- HEAD at workspace init: `204c8f9c3578f753af20727799aaa049b1545135`
- Message: `feat(banking): integrate verified G4 banking infrastructure`

That commit is both the design-audit baseline and the current `main` HEAD at initialization. Re-fetch remote before implementation if time has passed.

## Current phase

**G5.2 independent review:** APPROVE WITH REQUIRED CHANGES; documentation corrections are incorporated in the current G5.2 decision record.  
**Implementation remains NO-GO** until the owner explicitly authorizes a bounded slice and relevant release gates are satisfied.

Do not implement G5 models, Daraja clients, submission links, SMS parsers, or accounting changes without that authorization.

## Application tree

Standard backend layout under this folder: `src/`, `tests/`, `scripts/`, `package.json`, `package-lock.json`, existing G3/G4 code. `node_modules` is not included; install with `npm ci` when tests are required on a safe machine.


## G5 collection implementation
See [G5_COLLECTION_IMPLEMENTATION_DESIGN.md](G5_COLLECTION_IMPLEMENTATION_DESIGN.md) for Tenant M-PESA collection, credit, posting and protected-outbox design. Code published != tests verified != provider evidence != production readiness.
