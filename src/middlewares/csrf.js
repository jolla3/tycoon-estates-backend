// src/middlewares/csrf.js
//
// Cookie session auth across different frontend/API hosts cannot rely only
// on double-submit via document.cookie — the browser will not expose the
// API-domain csrf-token cookie to SPA JavaScript on another origin.
//
// Protection model:
//   1. Cross-origin browser requests always send Origin. We require Origin
//      to be in FRONTEND_URL (env). Attackers cannot forge Origin.
//   2. When the client *can* send X-CSRF-Token (same-origin or after
//      reading the exposed response header), it must match the cookie.
//   3. Login/signup remain exempt (no session yet to forge).
//   4. Webhooks never hit this middleware (mounted separately).

import crypto from 'crypto';
import { isProduction, isCrossSiteFrontend } from '../config/environment.js';
import { isAllowedOrigin } from '../config/security.js';
import { apiResponse } from '../utils/apiResponse.js';

const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);
const CSRF_EXEMPT_PATHS = new Set(['/auth/signup', '/auth/login']);

function ensureCsrfToken(req, res) {
  let token = req.cookies?.['csrf-token'];
  if (!token) {
    token = crypto.randomBytes(24).toString('hex');
    const crossSite = isCrossSiteFrontend();
    res.cookie('csrf-token', token, {
      httpOnly: false,
      secure: crossSite || isProduction,
      sameSite: crossSite || isProduction ? 'none' : 'lax',
      path: '/',
    });
  }
  // Always expose so a cross-origin SPA can store and echo the value.
  res.setHeader('X-CSRF-Token', token);
  return token;
}

export function issueCsrfCookie(req, res, next) {
  // Public probes must not Set-Cookie — Chrome Tracking Prevention can
  // block third-party fetches whose responses try to set cookies (blocked:other).
  const p = req.path || '';
  if (p === '/health' || p === '/ready' || p.endsWith('/health') || p.endsWith('/ready')) {
    return next();
  }
  ensureCsrfToken(req, res);
  next();
}

export function csrfProtection(req, res, next) {
  if (SAFE_METHODS.has(req.method)) return next();
  if (CSRF_EXEMPT_PATHS.has(req.path)) return next();

  const cookieToken = req.cookies?.['csrf-token'];
  const headerToken = req.headers['x-csrf-token'];
  const origin = req.headers.origin;

  // Prefer strict double-submit when the client sent the header.
  if (cookieToken && headerToken) {
    if (cookieToken === headerToken) return next();
    return apiResponse.error(res, 'FORBIDDEN', 'CSRF token missing or invalid', 403);
  }

  // Cross-origin SPA: browser sends Origin; it cannot be forged by a script.
  // Require an allowlisted Origin and a CSRF cookie (set on a prior response).
  if (origin) {
    if (!isAllowedOrigin(origin)) {
      return apiResponse.error(res, 'FORBIDDEN', 'Origin not allowed', 403);
    }
    if (!cookieToken) {
      // Prime cookie for the next attempt; still reject this mutation.
      ensureCsrfToken(req, res);
      return apiResponse.error(res, 'FORBIDDEN', 'CSRF token missing or invalid', 403);
    }
    return next();
  }

  // No Origin (same-site navigation or non-browser): require double-submit.
  if (!cookieToken || !headerToken || cookieToken !== headerToken) {
    return apiResponse.error(res, 'FORBIDDEN', 'CSRF token missing or invalid', 403);
  }
  next();
}