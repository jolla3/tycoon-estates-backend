// src/services/entitlement.service.js
//
// Superadmin V2 — canonical product entitlement authority.
//
// This is the ONLY place that decides whether a Client may use a gated
// product (BANKING, MPESA). Both HTTP middleware and background workers
// call into this module so the rule can never drift between the two.
//
// Rule (fixed, intentionally simple — do not expand):
//   Client exists AND Client.isActive === true
//     AND Subscription.products contains the requested product.
//
// Explicitly NEVER inferred from: plan, status, startDate/endDate,
// payment history, bank connections/accounts, merchant profiles, or any
// provider credential/verification state. No automatic expiry logic
// lives here — that is a separate, not-yet-authorized decision.
import { Client } from '../models/Client.js';
import { Subscription } from '../models/Subscription.js';

export const ENTITLEMENT_PRODUCTS = Object.freeze(['BANKING', 'MPESA']);

/**
 * @returns {Promise<{entitled: boolean, reason: string|null}>}
 * reason is one of: null (entitled), 'PRODUCT_UNKNOWN', 'CLIENT_NOT_FOUND',
 * 'CLIENT_INACTIVE', 'SUBSCRIPTION_MISSING', 'PRODUCT_NOT_ASSIGNED'.
 */
export async function checkEntitlement(clientId, product) {
  if (!ENTITLEMENT_PRODUCTS.includes(product)) {
    return { entitled: false, reason: 'PRODUCT_UNKNOWN' };
  }
  if (!clientId) {
    return { entitled: false, reason: 'CLIENT_NOT_FOUND' };
  }
  const client = await Client.findById(clientId).select('isActive').lean();
  if (!client) return { entitled: false, reason: 'CLIENT_NOT_FOUND' };
  if (client.isActive !== true) return { entitled: false, reason: 'CLIENT_INACTIVE' };

  const subscription = await Subscription.findOne({ clientId }).select('products').lean();
  if (!subscription || !Array.isArray(subscription.products)) {
    return { entitled: false, reason: 'SUBSCRIPTION_MISSING' };
  }
  if (!subscription.products.includes(product)) {
    return { entitled: false, reason: 'PRODUCT_NOT_ASSIGNED' };
  }
  return { entitled: true, reason: null };
}

/** Convenience boolean wrapper for callers (e.g. workers) that only need yes/no. */
export async function isEntitled(clientId, product) {
  const result = await checkEntitlement(clientId, product);
  return result.entitled;
}
