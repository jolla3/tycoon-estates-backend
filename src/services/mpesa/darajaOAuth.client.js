// src/services/mpesa/darajaOAuth.client.js
//
// G5.3 — Environment-aware Daraja OAuth client with in-process token cache.
// Consumer secrets never leave process memory into logs or DB fields.

import axios from 'axios';
import { DARAJA_BASE_URL, DARAJA_ENV, DARAJA_PATHS } from './daraja.constants.js';
import { logger } from '../../config/logger.js';

/** Safety margin before declared expiry (seconds). */
const EXPIRY_SKEW_SECONDS = 60;

/**
 * @param {object} options
 * @param {'sandbox'|'production'} options.environment
 * @param {string} options.consumerKey
 * @param {string} options.consumerSecret
 * @param {typeof axios} [options.http]
 */
export function createDarajaOAuthClient({
  environment = DARAJA_ENV.SANDBOX,
  consumerKey,
  consumerSecret,
  http = axios,
} = {}) {
  if (!consumerKey || !consumerSecret) {
    throw new Error('Daraja OAuth requires consumerKey and consumerSecret');
  }
  if (environment !== DARAJA_ENV.SANDBOX && environment !== DARAJA_ENV.PRODUCTION) {
    throw new Error(`Unsupported Daraja environment: ${environment}`);
  }

  const baseURL = DARAJA_BASE_URL[environment];
  let cached = null; // { accessToken, expiresAtMs }
  let inflight = null;

  function basicAuthHeader() {
    const token = Buffer.from(`${consumerKey}:${consumerSecret}`, 'utf8').toString('base64');
    return `Basic ${token}`;
  }

  function cacheValid() {
    return cached && cached.expiresAtMs > Date.now() + EXPIRY_SKEW_SECONDS * 1000;
  }

  async function fetchToken() {
    const url = `${baseURL}${DARAJA_PATHS.oauth}?grant_type=client_credentials`;
    try {
      const response = await http.get(url, {
        headers: {
          Authorization: basicAuthHeader(),
          Accept: 'application/json',
        },
        timeout: 15_000,
        validateStatus: () => true,
      });

      if (response.status === 200 && response.data?.access_token) {
        const expiresIn = Number(response.data.expires_in) || 3599;
        cached = {
          accessToken: String(response.data.access_token),
          expiresAtMs: Date.now() + expiresIn * 1000,
        };
        return cached.accessToken;
      }

      const err = new Error('Daraja OAuth token request failed');
      err.code = 'DARAJA_OAUTH_FAILED';
      err.status = response.status;
      throw err;
    } catch (error) {
      if (error.code === 'DARAJA_OAUTH_FAILED') throw error;
      const err = new Error('Daraja OAuth token request error');
      err.code = 'DARAJA_OAUTH_ERROR';
      err.causeCode = error.code || null;
      throw err;
    }
  }

  async function getAccessToken({ forceRefresh = false } = {}) {
    if (!forceRefresh && cacheValid()) {
      return cached.accessToken;
    }
    if (inflight) return inflight;

    inflight = (async () => {
      try {
        return await fetchToken();
      } finally {
        inflight = null;
      }
    })();

    return inflight;
  }

  function invalidate() {
    cached = null;
  }

  function debugState() {
    return {
      environment,
      baseURL,
      hasCachedToken: Boolean(cached?.accessToken),
      expiresAtMs: cached?.expiresAtMs ?? null,
      cacheValid: cacheValid(),
    };
  }

  return {
    environment,
    baseURL,
    getAccessToken,
    invalidate,
    debugState,
  };
}

/**
 * Load OAuth client from process env.
 * Unknown DARAJA_ENVIRONMENT fails closed (does not silently select sandbox).
 * Missing credentials return null.
 */
export function createDarajaOAuthClientFromEnv(envLike) {
  const rawEnv = (envLike.DARAJA_ENVIRONMENT || DARAJA_ENV.SANDBOX).toLowerCase();
  if (rawEnv !== DARAJA_ENV.SANDBOX && rawEnv !== DARAJA_ENV.PRODUCTION) {
    throw new Error(`Unknown DARAJA_ENVIRONMENT: ${envLike.DARAJA_ENVIRONMENT}`);
  }
  const environment = rawEnv === DARAJA_ENV.PRODUCTION ? DARAJA_ENV.PRODUCTION : DARAJA_ENV.SANDBOX;
  const consumerKey = envLike.DARAJA_CONSUMER_KEY;
  const consumerSecret = envLike.DARAJA_CONSUMER_SECRET;
  if (!consumerKey || !consumerSecret) {
    logger.debug({ environment }, 'Daraja OAuth credentials not configured');
    return null;
  }
  return createDarajaOAuthClient({ environment, consumerKey, consumerSecret });
}
