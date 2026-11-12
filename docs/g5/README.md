# G5 construction workspace

This directory is the **G5 construction workspace** for Tycoon Estates backend.

## Documents (read in order)

1. `architecture-summary.md` — short context, design invariants, and **workspace verification**.
2. `PRD.md` — product behaviour and acceptance criteria.
3. `architecture.md` — repository audit, domain design, routes, jobs, indexes, tests.
4. `G5_IMPLEMENTATION_GUARDRAILS.md` — mandatory agent conduct, source verification, no-guessing rules.
5. `G5_SOURCE_HEAD.txt` — recorded GitHub HEAD used to populate this workspace.

## Source baseline

- Repository: `https://github.com/jolla3/tycoon-estates-backend`
- Branch: `main`
- HEAD at workspace init: `204c8f9c3578f753af20727799aaa049b1545135`
- Message: `feat(banking): integrate verified G4 banking infrastructure`

That commit is both the design-audit baseline and the current `main` HEAD at initialization. Re-fetch remote before implementation if time has passed.

## Current phase

**G5.0 complete for documentation.**  
**G5.1+ implementation is not authorized** until the owner explicitly starts construction.

Do not implement G5 models, Daraja clients, submission links, SMS parsers, or accounting changes without that authorization.

## Application tree

Standard backend layout under this folder: `src/`, `tests/`, `scripts/`, `package.json`, `package-lock.json`, existing G3/G4 code. `node_modules` is not included; install with `npm ci` when tests are required on a safe machine.
