// src/config/security.js — Helmet + CORS (env-driven, no hardcoded origins).
import helmet from 'helmet';
import cors from 'cors';
import { env, isProduction } from './environment.js';

function normalizeOrigin(url) {
  if (!url || typeof url !== 'string') return '';
  return url.trim().replace(/\/+$/, '');
}

/** FRONTEND_URL may be one origin or a comma-separated list. */
const allowedOrigins = String(env.FRONTEND_URL || '')
  .split(',')
  .map(normalizeOrigin)
  .filter(Boolean);

export const helmetMiddleware = helmet({
  contentSecurityPolicy: isProduction ? undefined : false,
});

export const corsMiddleware = cors({
  origin(origin, callback) {
    // Non-browser clients (health checks, curl) may omit Origin.
    if (!origin) return callback(null, true);
    const incoming = normalizeOrigin(origin);
    if (allowedOrigins.includes(incoming)) return callback(null, true);
    return callback(new Error(`CORS blocked for origin: ${origin}`));
  },
  credentials: true,
  methods: ['GET', 'POST', 'PATCH', 'PUT', 'DELETE', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'X-CSRF-Token'],
});