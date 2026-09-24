// src/config/environment.js
//
// Application infrastructure config only.
// Never put customer/estate data here.
//
// ALL configuration values come from the environment (typically a local
// .env file that is gitignored). This module does not embed secrets,
// database URLs, or provider credentials as source-code defaults.

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import dotenv from 'dotenv';

// Load .env from the project root (two levels above src/config/), not from
// process.cwd(). That way nodemon/npm started from a parent directory still
// finds the correct file.
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(__dirname, '../..');
const envPath = path.join(projectRoot, '.env');

const dotenvResult = dotenv.config({ path: envPath });

const NODE_ENV = process.env.NODE_ENV || 'development';
const isProd = NODE_ENV === 'production';

/**
 * Required string from process.env. Empty / whitespace-only = missing.
 * No fallback values are embedded in source code.
 */
function required(name) {
  const raw = process.env[name];
  const value = typeof raw === 'string' ? raw.trim() : raw;
  if (value) return value;

  const envExists = fs.existsSync(envPath);
  const dotenvError = dotenvResult.error ? ` dotenv error: ${dotenvResult.error.message}.` : '';
  throw new Error(
    `[config] ${name} is required but was not found in the environment.\n` +
      `  Expected .env at: ${envPath}\n` +
      `  .env file exists: ${envExists}\n` +
      `  process.cwd(): ${process.cwd()}\n` +
      `${dotenvError}` +
      `  Add a line like: ${name}=your-value\n` +
      `  (No spaces around =. No quotes needed unless the value contains spaces.)`
  );
}

/**
 * Optional string — returns undefined when unset/blank.
 */
function optional(name) {
  const raw = process.env[name];
  const value = typeof raw === 'string' ? raw.trim() : raw;
  return value || undefined;
}

/**
 * ENCRYPTION_KEY must be 64 hex characters (32 bytes) for AES-256-GCM.
 */
function requiredEncryptionKey() {
  const key = required('ENCRYPTION_KEY');
  if (!/^[0-9a-fA-F]{64}$/.test(key)) {
    throw new Error(
      '[config] ENCRYPTION_KEY must be exactly 64 hexadecimal characters (32 bytes). ' +
        'Generate with: node -e "console.log(require(\'crypto\').randomBytes(32).toString(\'hex\'))"'
    );
  }
  return key;
}

export const env = {
  NODE_ENV,
  PORT: parseInt(process.env.PORT || '4000', 10),
  FRONTEND_URL: optional('FRONTEND_URL') || 'http://localhost:5173',
  TRUST_PROXY_HOPS: parseInt(process.env.TRUST_PROXY_HOPS || '1', 10),

  // Infrastructure — from .env only
  MONGODB_URI: required('MONGODB_URI'),
  REDIS_URL: required('REDIS_URL'),

  // Secrets — from .env only, never hardcoded in this file
  COOKIE_SECRET: required('COOKIE_SECRET'),
  SESSION_SECRET: required('SESSION_SECRET'),
  ENCRYPTION_KEY: requiredEncryptionKey(),

  // Co-operative Bank — all from .env (optional until you connect a bank)
  COOP_BASE_URL: optional('COOP_BASE_URL'),
  COOP_CLIENT_ID: optional('COOP_CLIENT_ID'),
  COOP_CLIENT_SECRET: optional('COOP_CLIENT_SECRET'),
  COOP_USERNAME: optional('COOP_USERNAME'),
  COOP_PASSWORD: optional('COOP_PASSWORD'),
  COOP_SCOPE: optional('COOP_SCOPE') || null,
  COOP_INS_BASIC_SECRET: optional('COOP_INS_BASIC_SECRET'),

  // Celcom Africa SMS — all from .env
  CELCOM_BASE_URL: optional('CELCOM_BASE_URL'),
  CELCOM_PARTNER_ID: optional('CELCOM_PARTNER_ID'),
  CELCOM_API_KEY: optional('CELCOM_API_KEY'),
  CELCOM_SENDER_ID: optional('CELCOM_SENDER_ID'),
};

export const isProduction = isProd;
