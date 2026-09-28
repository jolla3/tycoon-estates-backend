// src/config/security.js — Helmet + CORS (env-driven, no hardcoded origins).
import helmet from 'helmet';
import cors from 'cors';
import { env, isProduction } from './environment.js';

export function normalizeOrigin(url) {
  if (!url || typeof url !== 'string') return '';
  return url.trim().replace(/\/+$/, '');
}

/** FRONTEND_URL may be one origin or a comma-separated list. */
export function getAllowedOrigins() {
  return String(env.FRONTEND_URL || '')
    .split(',')
    .map(normalizeOrigin)
    .filter(Boolean);
}

export function isAllowedOrigin(origin) {
  if (!origin) return false;
  return getAllowedOrigins().includes(normalizeOrigin(origin));
}

export const helmetMiddleware = helmet({
  contentSecurityPolicy: isProduction ? undefined : false,
  // Default Helmet sets CORP same-origin, which blocks a cross-origin SPA
  // from reading API responses even when CORS allows the request.
  crossOriginResourcePolicy: { policy: 'cross-origin' },
  crossOriginOpenerPolicy: { policy: 'same-origin-allow-popups' },
});

export const corsMiddleware = cors({
  origin(origin, callback) {
    if (!origin) return callback(null, true);
    if (isAllowedOrigin(origin)) return callback(null, true);
    return callback(new Error(`CORS blocked for origin: ${origin}`));
  },
  credentials: true,
  methods: ['GET', 'POST', 'PATCH', 'PUT', 'DELETE', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'X-CSRF-Token'],
  // SPA cannot read the csrf-token cookie on a different host; expose it
  // on the response so the client can echo it on mutations when available.
  exposedHeaders: ['X-CSRF-Token'],
});