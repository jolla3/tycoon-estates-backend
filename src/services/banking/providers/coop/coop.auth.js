// src/services/banking/providers/coop/coop.auth.js
//
// Co-op Connect token acquisition for ONE bank connection.
//
// Customer credential contract: consumerKey + consumerSecret (CK/SK) only.
// No username/password/PIN/OTP, no tenant-supplied scope.
//
// What is NOT verified (and therefore not hard-coded here): the OAuth grant
// type, the token path, the scope string(s), the token TTL when the response
// omits `expires_in`, refresh-token use, and production hosts. They come from
// platform configuration (COOP_TOKEN_PATH, COOP_TOKEN_GRANT_TYPE,
// COOP_TOKEN_SCOPE). If the path or grant type is not configured,
// authentication fails closed WITHOUT any network call. The exact outstanding
// provider requirement is recorded in docs/provider-contracts/.
//
// Tokens live only in this instance (connection-scoped; never shared across
// connections) and are never logged. Secrets never appear in errors or logs.

import axios from 'axios';
import { env } from '../../../../config/environment.js';
import { logger } from '../../../../config/logger.js';
import { Errors } from '../../../../utils/errors.js';

const EXPIRY_SAFETY_MARGIN_MS = 60_000;

export class CoopAuthService {
  constructor({ baseUrl, consumerKey, consumerSecret, tokenConfig } = {}) {
    this.baseUrl = baseUrl;
    this.consumerKey = consumerKey;
    this.consumerSecret = consumerSecret;
    this.tokenConfig = tokenConfig || {
      path: env.COOP_TOKEN_PATH,
      grantType: env.COOP_TOKEN_GRANT_TYPE,
      scope: env.COOP_TOKEN_SCOPE,
    };
    this._token = null;
    this._expiresAt = 0;
    this._inflight = null;
  }

  async getAccessToken() {
    if (this._token && Date.now() < this._expiresAt - EXPIRY_SAFETY_MARGIN_MS) {
      return this._token;
    }
    // Single-flight: concurrent callers share one token request.
    if (!this._inflight) {
      this._inflight = this._requestNewToken().finally(() => { this._inflight = null; });
    }
    return this._inflight;
  }

  async _requestNewToken() {
    if (!this.consumerKey || !this.consumerSecret) {
      throw Errors.BankAuthFailed('Co-op consumer key and secret are required for this connection');
    }
    const { path, grantType, scope } = this.tokenConfig;
    if (!this.baseUrl || !path || !grantType) {
      // Deliberately no guessed grant/path/scope: sending an unverified
      // contract can look like a working integration until a real call fails.
      throw Errors.BankAuthFailed('Co-op token contract is not configured for this platform');
    }

    const basicAuth = Buffer.from(`${this.consumerKey}:${this.consumerSecret}`).toString('base64');
    const form = new URLSearchParams({ grant_type: grantType });
    if (scope) form.set('scope', scope);

    try {
      const response = await axios.post(`${this.baseUrl}${path}`, form.toString(), {
        headers: {
          Authorization: `Basic ${basicAuth}`,
          'Content-Type': 'application/x-www-form-urlencoded',
        },
        timeout: 15000,
      });
      const token = response.data?.access_token;
      if (!token || typeof token !== 'string') {
        throw new Error('token response missing access_token');
      }
      this._token = token;
      // Cache only for a provider-stated lifetime. No assumed TTL: without a
      // valid expires_in the token is used once and re-requested next time.
      const ttlSec = Number(response.data.expires_in);
      this._expiresAt = Number.isFinite(ttlSec) && ttlSec > 0 ? Date.now() + ttlSec * 1000 : 0;
      logger.info('Co-op access token acquired');
      return token;
    } catch (err) {
      // Never log err.config (carries the Authorization header) or response bodies.
      logger.error({ status: err.response?.status }, 'Co-op authentication failed');
      this.invalidate();
      throw Errors.BankAuthFailed('Failed to authenticate with Co-op Bank');
    }
  }

  /** Forces a new token on the next getAccessToken() call (e.g. after a 401). */
  invalidate() {
    this._token = null;
    this._expiresAt = 0;
  }
}
