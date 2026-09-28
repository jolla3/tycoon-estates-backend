// src/middlewares/csrf.js
//
// Section 4/25: double-submit-cookie CSRF check. Because auth is
// cookie-based, SameSite alone is not treated as sufficient protection.
//
// Exemptions, and why each is safe:
//   - /webhooks/*   — authenticated via the bank's own mechanism (Basic
//     credential), not our session cookie; there is no session to forge.
//   - POST /auth/signup, POST /auth/login — there is no pre-existing
//     session yet to protect against forgery at this point. Without this
//     exemption, a client's very first-ever request can never carry a
//     matching CSRF token: issueCsrfCookie only sets the cookie on the
//     RESPONSE, so req.cookies on that same request still has nothing to
//     compare against — signup/login would be permanently unreachable
//     without a client first making some other GET request purely to
//     prime the cookie. ("Login CSRF" — tricking a victim into logging
//     into an attacker's account — is a real but much lower-severity
//     concern than protecting authenticated state changes, and doesn't
//     apply to signup at all since it creates a brand-new account.)

import crypto from 'crypto';
import { isProduction, isCrossSiteFrontend } from '../config/environment.js';
import { apiResponse } from '../utils/apiResponse.js';

const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);
const CSRF_EXEMPT_PATHS = new Set(['/auth/signup', '/auth/login']);

export function issueCsrfCookie(req, res, next) {
  if (!req.cookies['csrf-token']) {
    const crossSite = isCrossSiteFrontend();
    res.cookie('csrf-token', crypto.randomBytes(24).toString('hex'), {
      httpOnly: false, // must be readable by JS so it can be echoed back in a header
      secure: crossSite || isProduction,
      sameSite: crossSite || isProduction ? 'none' : 'lax',
      path: '/',
    });
  }
  next();
}

export function csrfProtection(req, res, next) {
  if (SAFE_METHODS.has(req.method)) return next();
  // NOTE: webhook traffic never reaches this middleware at all — it's
  // handled by the separately-mounted webhookRoutes BEFORE this app.use
  // layer runs (see app.js), so there is no path check needed here for
  // it. (An earlier version of this check compared req.path against a
  // '/api/v1/...'-prefixed string, which — verified empirically — can
  // never match here: Express strips the app.use('/api/v1', ...) mount
  // prefix from req.path within this layer, so it would have been dead
  // code even if webhook traffic did somehow reach it.)
  if (CSRF_EXEMPT_PATHS.has(req.path)) return next();

  const cookieToken = req.cookies['csrf-token'];
  const headerToken = req.headers['x-csrf-token'];
  if (!cookieToken || !headerToken || cookieToken !== headerToken) {
    return apiResponse.error(res, 'FORBIDDEN', 'CSRF token missing or invalid', 403);
  }
  next();
}