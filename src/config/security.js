// src/config/security.js — Helmet + CORS configuration (section 25).
import helmet from 'helmet';
import cors from 'cors';
import { env, isProduction } from './environment.js';

export const helmetMiddleware = helmet({
  contentSecurityPolicy: isProduction ? undefined : false,
});

export const corsMiddleware = cors({
  origin: env.FRONTEND_URL,
  credentials: true, // required for cookies to flow cross-origin
  methods: ['GET', 'POST', 'PATCH', 'PUT', 'DELETE'],
  allowedHeaders: ['Content-Type', 'X-CSRF-Token'],
});
