// src/middlewares/clientContext.js
//
// Section 2/3/35 (V2): derives the authenticated request's Client scope
// from the session-authenticated user — NEVER from req.body.clientId,
// req.query.clientId, or any other client-supplied field.
//
// Also derives the enforced estate sub-scope via req.estateFilter, which
// every service consumes through utils/estateFilter.js#applyEstateFilter:
//   - null            -> user has no estate restriction (full client access)
//   - a single string  -> user (or SUPER_ADMIN) asked for one specific,
//                        already-verified estate
//   - an array of ids  -> user IS restricted to specific estates and did
//                        NOT name one explicitly — every list/report query
//                        must filter to exactly these, never "all"
//
// PRIOR BUG (fixed here): when a restricted user made a request with no
// estateId in params/query, req.estateId was set to `null`, and every
// service interpreted `null` as "no filter" — i.e. every list/report
// endpoint silently returned data for EVERY estate under the client,
// including ones that user was never granted. req.estateFilter closes
// that gap by always carrying the user's actual allowed set forward.

import { apiResponse } from '../utils/apiResponse.js';
import { Client } from '../models/Client.js';

export async function clientContext(req, res, next) {
  try {
    if (!req.currentUser) return apiResponse.error(res, 'AUTH_REQUIRED', 'Authentication required', 401);

    // Defense in depth: if a request smuggled these fields in, strip them
    // before they can reach a service layer that might (incorrectly) trust
    // req.body for identity — see utils/validators.js for the schema-level
    // rejection of the same fields.
    delete req.body?.clientId;
    delete req.body?.userId;
    delete req.body?.role;

    if (req.currentUser.role === 'SUPER_ADMIN') {
      // Platform-level admins must still name one explicit client per
      // request — there is no "operate across every client" wildcard.
      // Platform routes under /platform do not use this middleware.
      const requestedClientId = req.query.clientId || req.params.clientId;
      if (!requestedClientId) return apiResponse.error(res, 'INVALID_REQUEST', 'clientId is required for SUPER_ADMIN requests', 422);

      const client = await Client.findOne({ _id: requestedClientId, isActive: true });
      if (!client) return apiResponse.error(res, 'INVALID_REQUEST', 'No active client with that clientId', 422);

      req.clientId = requestedClientId;
      req.estateId = req.params.estateId || req.query.estateId || null;
      req.estateFilter = req.estateId; // SUPER_ADMIN has no estateIds restriction to enforce
      return next();
    }

    if (!req.currentUser.clientId) {
      return apiResponse.error(res, 'FORBIDDEN', 'This user has no client assigned', 403);
    }

    // Deactivated clients cannot perform normal operations.
    const ownClient = await Client.findById(req.currentUser.clientId).select('isActive');
    if (!ownClient || !ownClient.isActive) {
      return apiResponse.error(res, 'FORBIDDEN', 'This client account is inactive', 403);
    }

    req.clientId = req.currentUser.clientId;

    const requestedEstateId = req.params.estateId || req.query.estateId;
    const allowedEstateIds = (req.currentUser.estateIds || []).map(String);
    const isRestricted = allowedEstateIds.length > 0;

    if (requestedEstateId && isRestricted && !allowedEstateIds.includes(String(requestedEstateId))) {
      return apiResponse.error(res, 'FORBIDDEN', 'You do not have access to this estate', 403);
    }

    req.estateId = requestedEstateId || null;
    // The load-bearing value every service must actually filter by:
    req.estateFilter = requestedEstateId || (isRestricted ? allowedEstateIds : null);

    next();
  } catch (err) {
    next(err);
  }
}
