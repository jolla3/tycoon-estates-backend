# G5 Documentation Index

This directory contains the G5 collection, tenancy, payment and operational design records for Tycoon Estates.

## Current audited correction workspace

The current dedicated requirements and architecture set for the audited rent-lifecycle and receipt corrections is:

1. [Audited corrections handoff](audited-corrections/architecture-summary.md) — short product and engineering context, locked rules and implementation order.
2. [Audited corrections PRD](audited-corrections/PRD.md) — user-visible outcomes, business invariants and acceptance criteria.
3. [Audited corrections architecture](audited-corrections/architecture.md) — source audit, data flow, service boundaries, failure modes and implementation design gates.
4. [Folder README](audited-corrections/README.md) — scope, authority and change-control notes.

Workspace branch: docs/g5-audited-corrections-readiness  
Baseline: main at 2a291df091d35172f75b067acfca94179a3ebb36

## Existing G5 design records

- G5_COLLECTION_IMPLEMENTATION_DESIGN.md — overall collection, attribution, settlement and protected outbox design.
- G5_1_SCHEMA_INDEX_DESIGN.md — schema and index design.
- G5_2_TENANCY_LINK_AND_OUTBOX_DESIGN.md — tenancy lifecycle, protected SMS outbox and independent review resolution.
- G5_3_PROVIDER_INGESTION_DESIGN.md — provider ingestion and receipt evidence.
- G5_IMPLEMENTATION_GUARDRAILS.md — implementation safety and source-verification rules.
- PRD.md — historical G5 product requirements and decision record.
- architecture.md — historical G5 architecture and implementation record.
- architecture-summary.md — historical G5 engineering handoff.

The historical G5.2 status and source-baseline notes in those records describe their original workspace checkpoint. Re-check the current branch and source before relying on an old implementation status.

## Related notification documentation

The existing notification documents remain relevant for unaffected estate identity, protected-link, outbox, SMS dispatch and provider-delivery behaviour:

- docs/G5_NOTIFICATIONS_PRD.md
- docs/G5_NOTIFICATIONS_ARCHITECTURE.md
- docs/G5_NOTIFICATIONS_SUMMARY.md

For the audited correction scope, the new audited-corrections PRD is authoritative where older notification text says registration billing messages must be derived only from generated RentCharge rows. Registration plan messaging must use the exact House billing configuration effective on registration date. The existing D-5 reminder lead time remains correct and must not be changed.

Before implementation, reconcile those older notification documents with the dedicated correction set while preserving all unaffected link, outbox, estate-scoping and delivery rules.

## Change-control boundary

The audited-corrections documents are a documentation baseline, not implementation authorization. They do not authorize application code changes, migrations, production provider calls, live SMS, callback exposure, feature-flag changes or automatic financial posting enablement.

The separate C2B merchant registration/callback-readiness work remains a distinct workstream. Keep merchant collection readiness, provider receipt trust and G3 posting authorization as separate gates.
