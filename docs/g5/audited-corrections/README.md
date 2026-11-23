# G5 Audited Corrections

This folder is the single requirements and architecture entry point for the audited G5 rent-lifecycle and receipt corrections.

## Read order

1. [Engineering handoff](architecture-summary.md)
2. [Product requirements](PRD.md)
3. [Architecture and data flow](architecture.md)

## Authority and boundaries

These documents define the audited correction scope for registration billing snapshots, D-5 reminder line accuracy, consistent Bank/M-PESA settlement, transaction-time tenancy validation, canonical Payments reporting and staff mobile actions.

They do not replace the existing G5 protected-link/outbox design or the separate C2B merchant registration/callback-readiness work. Where older notification documentation says registration billing text must be derived only from current RentCharge rows, this audited requirements set supersedes that statement for registration-plan messaging. D-5 timing remains unchanged.

Before implementation, reconcile the older G5 notification PRD, architecture and summary with this folder so readers do not have to resolve contradictory statements themselves. Keep unaffected token, outbox, provider, estate identity and delivery rules intact.

## Change control

This is a documentation-only baseline. It does not authorize application code changes, database migrations, provider calls, live SMS, production callback exposure, feature-flag changes or financial posting enablement.
