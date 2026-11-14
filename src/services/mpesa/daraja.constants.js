// src/services/mpesa/daraja.constants.js
//
// G5.3 — Daraja endpoint constants and operational enums.
// Paths avoid embedding production credentials. Keyword-safe public callback
// routes are defined here for registration documentation (see FAQs:
// avoid "mpesa", "query", "safaricom" in callback URL paths).

export const DARAJA_PROVIDER = 'SAFARICOM';

export const DARAJA_ENV = Object.freeze({
  SANDBOX: 'sandbox',
  PRODUCTION: 'production',
});

export const DARAJA_BASE_URL = Object.freeze({
  sandbox: 'https://sandbox.safaricom.co.ke',
  production: 'https://api.safaricom.co.ke',
});

export const DARAJA_PATHS = Object.freeze({
  oauth: '/oauth/v1/generate',
  /** Confirm app enablement for v1 vs v2 in the Daraja portal before production. */
  c2bRegisterUrl: '/mpesa/c2b/v1/registerurl',
  /** Portal may expose v2; set DARAJA_C2B_REGISTER_PATH to override after verification. */
  c2bRegisterUrlV2: '/mpesa/c2b/v2/registerurl',
  c2bSimulate: '/mpesa/c2b/v1/simulate',
  pullRegister: '/pulltransactions/v1/register',
  pullQuery: '/pulltransactions/v1/query',
});

/** Public routes mounted under /api/v1/webhooks (no CSRF). */
export const DARAJA_WEBHOOK_PATHS = Object.freeze({
  c2bConfirmation: '/daraja/c2b/confirm',
  c2bValidation: '/daraja/c2b/validate',
  pullResult: '/daraja/pull/results',
});

export const C2B_RESPONSE_TYPE = Object.freeze({
  COMPLETED: 'Completed',
  CANCELLED: 'Cancelled',
});

export const C2B_COMMAND = Object.freeze({
  PAYBILL: 'CustomerPayBillOnline',
  BUY_GOODS: 'CustomerBuyGoodsOnline',
});

export const INGESTION_SOURCE = Object.freeze({
  C2B_CONFIRMATION: 'C2B_CONFIRMATION',
  C2B_VALIDATION: 'C2B_VALIDATION',
  PULL_QUERY: 'PULL_QUERY',
  PULL_CALLBACK: 'PULL_CALLBACK',
});

export const INGESTION_STATE = Object.freeze({
  RECEIVED: 'RECEIVED',
  PROCESSING: 'PROCESSING',
  PROCESSED: 'PROCESSED',
  QUARANTINED: 'QUARANTINED',
  FAILED_RETRYABLE: 'FAILED_RETRYABLE',
  FAILED_TERMINAL: 'FAILED_TERMINAL',
});

export const TXN_VERIFICATION_STATE = Object.freeze({
  UNVERIFIED: 'UNVERIFIED',
  MATCHED: 'MATCHED',
  CONFLICT: 'CONFLICT',
  MANUAL_REVIEW: 'MANUAL_REVIEW',
});

export const PULL_REGISTER_CODE = Object.freeze({
  SUCCESS: '1000',
  ALREADY_REGISTERED: '1001',
});
