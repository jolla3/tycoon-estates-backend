// src/middlewares/requireProduct.js
//
// Superadmin V2 — HTTP product-entitlement gate. Must be mounted AFTER
// `clientContext` (it needs the already-resolved, trusted req.clientId)
// and BEFORE role-based `authorize(...)` on client-facing Banking/MPESA
// routes. See src/services/entitlement.service.js for the single rule
// this enforces.
//
// A SUPER_ADMIN hitting a CUSTOMER-FACING route (e.g. the tenant M-PESA
// collection endpoints) does NOT bypass this gate — platform operators
// administer entitlements via /api/v1/platform, not by riding through a
// client's own product routes.
import { apiResponse } from '../utils/apiResponse.js';
import { checkEntitlement } from '../services/entitlement.service.js';

export function requireProduct(product) {
  return async function requireProductMiddleware(req, res, next) {
    try {
      const { entitled, reason } = await checkEntitlement(req.clientId, product);
      if (!entitled) {
        return apiResponse.error(
          res,
          'PRODUCT_NOT_ENTITLED',
          `This client is not entitled to the ${product} product`,
          403,
          { product, reason }
        );
      }
      next();
    } catch (err) {
      next(err);
    }
  };
}
