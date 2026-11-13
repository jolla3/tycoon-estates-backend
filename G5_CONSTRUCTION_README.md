# G5 construction workspace (Git)

- **Branch:** `feature/g5-construction`
- **Baseline HEAD:** `204c8f9c3578f753af20727799aaa049b1545135`

## Where G5 design docs live

Tracked repository root still has the pre-G5 `PRD.md` / `architecture.md` / `architecture-summary.md` / `README.md` from the baseline commit. Those were **not** overwritten.

G5.0 design authority for this construction workspace:

| Document | Path |
|----------|------|
| PRD | `docs/g5/PRD.md` |
| Architecture | `docs/g5/architecture.md` |
| Architecture summary | `docs/g5/architecture-summary.md` |
| Implementation guardrails | `G5_IMPLEMENTATION_GUARDRAILS.md` (also `docs/g5/`) |
| G5 workspace README | `docs/g5/README.md` |
| Source HEAD record | `G5_SOURCE_HEAD.txt` |
| Integrity audit | `docs/G5_0_1_WORKSPACE_INTEGRITY_AND_DECISION_AUDIT.md` |

Status (kept separate on purpose):
- **Code published on this branch:** G5.3 Daraja ingestion (earlier) plus the Tenant collection slice (submission link, public submission API, parser, Tenant credit, multi-Tenancy posting service, protected SMS outbox, guarded migrations). See `docs/g5/G5_COLLECTION_IMPLEMENTATION_DESIGN.md`.
- **Verified by tests:** unit tests only (see commit message / final report). MongoDB replica-set integration tests are written but have NOT been executed.
- **Blocked by provider/owner evidence:** B01-B05, B07-B10.
- **Production readiness:** none claimed. Posting and submissions are OFF by default.
