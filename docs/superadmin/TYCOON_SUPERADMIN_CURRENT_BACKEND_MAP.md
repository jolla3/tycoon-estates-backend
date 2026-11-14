# Tycoon Estates Superadmin — Current Backend Map

**Status:** Static map of verified backend state plus the target boundaries to preserve (revised for entitlement enforcement, workers, callbacks, subscription authority, migration)  
**Date:** 2026-11-14  
**Repository:** `jolla3/tycoon-estates-backend`  
**Verified `main` HEAD (pre-doc-update):** `d482782345e07e1366188261a51e92fd46027536`  
**Platform source baseline (unchanged blobs):** still match inspection at `d322374abac0cd35ce205e916de70c453af0eeda`  
**Full requirements:** [`TYCOON_SUPERADMIN_BACKEND_FIRST_BASELINE.md`](./TYCOON_SUPERADMIN_BACKEND_FIRST_BASELINE.md)  
**Detailed design:** [`TYCOON_SUPERADMIN_REVIEW_BASELINE.md`](./TYCOON_SUPERADMIN_REVIEW_BASELINE.md)  
**Implementation code:** not authorized; this revision is documentation only

---

## 1. Product in one paragraph

The Superadmin Console is the internal control plane for the Tycoon Platform Manager. The Manager creates and manages client businesses, explicitly assigns Banking and/or M-PESA, assigns monthly subscriptions or trials, and monitors each client's integrations and platform operations. It is not a customer tenant portal and it must preserve existing G3/G4/G5 domain boundaries.

## 2. Locked business rules

- Tycoon is the platform; the Manager is the platform operator; each customer is a separate Client tenant.
- A Client may be assigned `BANKING`, `MPESA`, both, or neither. Do not impose a one-product-only client type.
- Product entitlement is explicit Manager assignment. It is not inferred from whether a bank connection or M-PESA profile exists.
- Integration configuration/readiness is a separate dimension from product entitlement.
- Subscriptions are monthly based and assigned/managed by the Platform Manager.
- Trial is a trial. An active subscription assignment is not proof of payment.
- Payment is recorded as received only when a real transaction record exists and is associated with the subscription. Do not reuse tenant rent payments as subscription payment evidence.
- No automated subscription billing, invoices, checkout, dunning, prices, grace-period logic or invented plan features in this scope.
- Tycoon owns the Daraja application and platform Consumer Key/Secret. Each client owns its own Till/shortcode, stored in its client-scoped merchant profile.
- Do not invent client-specific M-PESA secrets unless a verified provider contract requires them.
- Bank credentials are issued for each client and stored per client bank connection, encrypted and isolated. Preserve the existing G4 model.
