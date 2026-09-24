// src/services/banking/providers/coop/coop.auth.js
//
// Rewritten against Co-op Connect's actual documented auth flow (the V1
// version of this file assumed a generic client_credentials POST — that
// was wrong; this replaces it).
//
// Per the supplied Co-op Connect docs ("Authentication" section):
//
//   1. Dynamic Client Registration (DCR) — a ONE-TIME setup step done via
//      the developer portal / a registration call, producing a
//      clientId/clientSecret pair. This is not a runtime concern for this
//      service; COOP_CLIENT_ID / COOP_CLIENT_SECRET are assumed to already
//      exist by the time this code runs.
//
//   2. Token acquisition — the documented example uses the OAuth2
//      *password* grant, NOT client_credentials:
//
//        curl https://<host>:<gateway_port>/token -k \
//          -H "Authorization: Basic base64(client_id:client_secret)" \
//          -d "grant_type=password&username=<u>&password=<p>&scope=<scopes>"
//
//      i.e. form-urlencoded body, Basic-auth'd with the DCR client
//      credentials, resource-owner username/password as separate
//      COOP_USERNAME/COOP_PASSWORD env vars, and a scope string whose
//      actual value for AccountTransactions/AccountFullStatement/
//      AccountBalance/AccountValidation was NOT given in the supplied
//      docs — COOP_SCOPE is configurable precisely because of that gap.
//
//   3. Response: { access_token, refresh_token, scope, token_type,
//      expires_in }. Token is cached and reused until near expiry.

import axios from 'axios';
import { logger } from '../../../../config/logger.js';
import { Errors } from '../../../../utils/errors.js';

const EXPIRY_SAFETY_MARGIN_MS = 60_000;

export class CoopAuthService {
  constructor({ baseUrl, clientId, clientSecret, username, password, scope }) {
    this.baseUrl = baseUrl;
    this.clientId = clientId;
    this.clientSecret = clientSecret;
    this.username = username;
    this.password = password;
    this.scope = scope;
    this._token = null;
    this._refreshToken = null;
    this._expiresAt = 0;
  }

  async getAccessToken() {
    if (this._token && Date.now() < this._expiresAt - EXPIRY_SAFETY_MARGIN_MS) {
      return this._token;
    }
    return this._requestNewToken();
  }

  async _requestNewToken() {
    if (!this.clientId || !this.clientSecret) {
      throw Errors.BankAuthFailed('COOP_CLIENT_ID / COOP_CLIENT_SECRET are not configured');
    }
    if (!this.username || !this.password) {
      throw Errors.BankAuthFailed('COOP_USERNAME / COOP_PASSWORD are not configured (Co-op Connect uses the password grant, not client_credentials)');
    }
    if (!this.scope) {
      // Deliberately not defaulting to a guessed value (e.g. "default")
      // — sending an OAuth scope Co-op never actually granted can look
      // like a working integration right up until the first call that
      // genuinely needs a scope 401s. Fail loudly and immediately instead.
      throw Errors.BankAuthFailed('COOP_SCOPE is not configured — get the required scope string(s) from Co-op\'s developer portal for your subscribed APIs before connecting a real account');
    }

    const basicAuth = Buffer.from(`${this.clientId}:${this.clientSecret}`).toString('base64');
    const body = new URLSearchParams({
      grant_type: 'password',
      username: this.username,
      password: this.password,
      scope: this.scope,
    });

    try {
      const response = await axios.post(`${this.baseUrl}/token`, body.toString(), {
        headers: {
          Authorization: `Basic ${basicAuth}`,
          'Content-Type': 'application/x-www-form-urlencoded',
        },
        timeout: 15000,
      });

      this._token = response.data.access_token;
      this._refreshToken = response.data.refresh_token || null;
      const expiresInMs = (response.data.expires_in || 3600) * 1000;
      this._expiresAt = Date.now() + expiresInMs;

      logger.info({ expiresInSec: response.data.expires_in, scope: response.data.scope }, 'Co-op access token acquired');
      return this._token;
    } catch (err) {
      logger.error({ error: err.message, status: err.response?.status }, 'Co-op authentication failed');
      throw Errors.BankAuthFailed('Failed to authenticate with Co-op Bank');
    }
  }

  /** Forces a refresh on the next getAccessToken() call — e.g. after a 401 from Co-op. */
  invalidate() {
    this._token = null;
    this._expiresAt = 0;
  }
}
