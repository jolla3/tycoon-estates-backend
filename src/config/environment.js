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

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(__dirname, '../..');
const envPath = path.join(projectRoot, '.env');

const dotenvResult = dotenv.config({ path: envPath });

const NODE_ENV = process.env.NODE_ENV || 'development';
const isProd = NODE_ENV === 'production';
export const isTest = NODE_ENV === 'test';

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

function optional(name) {
  const raw = process.env[name];
  const value = typeof raw === 'string' ? raw.trim() : raw;
  return value || undefined;
}

function optionalHttpsOrigin(name) {
  const value = optional(name);
  if (!value) return undefined;

  let parsed;
  try {
    parsed = new URL(value);
  } catch {
    throw new Error(
      `[config] ${name} must be one HTTPS origin, for example https://tycoon-frontend.vercel.app`
    );
  }

  if (
    value.includes(',') ||
    parsed.protocol !== 'https:' ||
    parsed.origin !== value ||
    parsed.pathname !== '/' ||
    parsed.search !== '' ||
    parsed.hash !== '' ||
    parsed.username !== '' ||
    parsed.password !== ''
  ) {
    throw new Error(
      `[config] ${name} must be one HTTPS origin without a path, query, fragment, credentials, or comma-separated hosts`
    );
  }

  return parsed.origin;
}

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
  FRONTEND_URL: (optional('FRONTEND_URL') || 'http://localhost:5173').replace(/\/+$/, ''),
  // One customer-facing payment origin. Keep FRONTEND_URL as the multi-origin CORS allowlist.
  G5_PUBLIC_PAYMENT_URL: optionalHttpsOrigin('G5_PUBLIC_PAYMENT_URL'),
  TRUST_PROXY_HOPS: parseInt(process.env.TRUST_PROXY_HOPS || '1', 10),

  MONGODB_URI: isTest
    ? (optional('MONGODB_URI') || 'mongodb://127.0.0.1:1/tycoon_test_config_only')
    : required('MONGODB_URI'),
  REDIS_URL: isTest
    ? (optional('REDIS_URL') || optional('REDIS_TEST_URL') || 'redis://127.0.0.1:1')
    : required('REDIS_URL'),

  COOKIE_SECRET: required('COOKIE_SECRET'),
  SESSION_SECRET: required('SESSION_SECRET'),
  ENCRYPTION_KEY: requiredEncryptionKey(),

  COOP_BASE_URL: optional('COOP_BASE_URL'),
  // Token-endpoint contract is PLATFORM configuration and has no default:
  // the grant type, path and scope for Co-op Connect are not verified, so an
  // unset value makes authentication fail closed (no network call).
  // Tenant credentials are consumerKey/consumerSecret only (per connection).
  COOP_TOKEN_PATH: optional('COOP_TOKEN_PATH') || null,
  COOP_TOKEN_GRANT_TYPE: optional('COOP_TOKEN_GRANT_TYPE') || null,
  COOP_TOKEN_SCOPE: optional('COOP_TOKEN_SCOPE') || null,
  COOP_INS_BASIC_SECRET: optional('COOP_INS_BASIC_SECRET'),
  BANK_SECRETS_ENCRYPTION_KEY: optional('BANK_SECRETS_ENCRYPTION_KEY') || '',
  BANK_SECRETS_ENCRYPTION_KEY_PREVIOUS: optional('BANK_SECRETS_ENCRYPTION_KEY_PREVIOUS') || '',
  COOP_BANK_LAB_MODE: optional('COOP_BANK_LAB_MODE') === '1',
  COOP_WEBHOOK_LAB_OVERRIDE: optional('COOP_WEBHOOK_LAB_OVERRIDE') === '1',

  CELCOM_BASE_URL: optional('CELCOM_BASE_URL'),
  CELCOM_PARTNER_ID: optional('CELCOM_PARTNER_ID'),
  CELCOM_API_KEY: optional('CELCOM_API_KEY'),
  CELCOM_SENDER_ID: optional('CELCOM_SENDER_ID'),

  DARAJA_ENVIRONMENT: optional('DARAJA_ENVIRONMENT') || 'sandbox',
  DARAJA_CONSUMER_KEY: optional('DARAJA_CONSUMER_KEY'),
  DARAJA_CONSUMER_SECRET: optional('DARAJA_CONSUMER_SECRET'),
  /** Public https origin Tycoon hosts the shared Daraja callbacks on (platform-owned, not per client). */
  DARAJA_CALLBACK_BASE_URL: optional('DARAJA_CALLBACK_BASE_URL'),
  DARAJA_CALLBACKS_ENABLED: optional('DARAJA_CALLBACKS_ENABLED') === '1' ? '1' : '',
  DARAJA_CALLBACKS_LAB: optional('DARAJA_CALLBACKS_LAB') === '1' ? '1' : '',
  /** Explicit opt-in for scheduled Pull query/reconciliation (default off). */
  // G5 collection (all fail-closed when unset)
  G5_MPESA_POSTING_ENABLED: optional('G5_MPESA_POSTING_ENABLED') === '1' ? '1' : '',
  G5_SUBMISSIONS_ENABLED: optional('G5_SUBMISSIONS_ENABLED') === '1' ? '1' : '',
  G5_SMS_EVIDENCE_RETENTION_APPROVED: optional('G5_SMS_EVIDENCE_RETENTION_APPROVED') === '1' ? '1' : '',
  G5_PROTECTED_SMS_ENABLED: optional('G5_PROTECTED_SMS_ENABLED') === '1' ? '1' : '',
  DARAJA_PULL_RECONCILIATION_ENABLED: optional('DARAJA_PULL_RECONCILIATION_ENABLED') === '1' ? '1' : '',
};


function validateG5EnvelopeKeyring() {
  const raw = optional('G5_ENVELOPE_KEYS');
  if (!raw) {
    if (!isTest && (env.G5_PROTECTED_SMS_ENABLED === '1' || env.G5_PUBLIC_PAYMENT_URL)) {
      throw new Error('[config] G5_ENVELOPE_KEYS is required when public payment links or protected SMS are enabled');
    }
    return;
  }
  const seen = new Set();
  for (const part of raw.split(',').map((value) => value.trim()).filter(Boolean)) {
    const pieces = part.split(':');
    const [id, hex] = pieces;
    if (pieces.length !== 2 || !/^[A-Za-z0-9_-]{1,16}$/.test(id || '') || !/^[0-9a-fA-F]{64}$/.test(hex || '') || seen.has(id)) {
      throw new Error('[config] G5_ENVELOPE_KEYS entries must be unique id:64hex values');
    }
    seen.add(id);
  }
  if (seen.size === 0) throw new Error('[config] G5_ENVELOPE_KEYS contains no usable key');
}

// Validate at boot, before a tenant registration or dispatcher first touches the keyring.
validateG5EnvelopeKeyring();

export function isCrossSiteFrontend() {
  const raw = String(env.FRONTEND_URL || '');
  const parts = raw.split(',').map((s) => s.trim()).filter(Boolean);
  if (parts.length === 0) return isProd;
  try {
    return parts.some((p) => {
      const host = new URL(p).hostname;
      return host !== 'localhost' && host !== '127.0.0.1';
    });
  } catch {
    return isProd;
  }
}

export const isProduction = isProd;
