// src/services/banking/providers/coop/coop.auth.js
//
// Co-op Connect 2.0.0 — normal customer onboarding uses CK/SK client_credentials.
// Password grant is not the default and is not an automatic fallback.
//
// Token state is coordinated in-process, keyed by connection + credential version
// + grant + scope + token endpoint. Tokens are never shared across connections
// or credential generations. No Redis token store.

import axios from 'axios';
import { logger } from '../../../../config/logger.js';
import { Errors } from '../../../../utils/errors.js';

const EXPIRY_SAFETY_MARGIN_MS = 60_000;

/** @type {Map<string, { token: string|null, expiresAt: number, inflight: Promise<string>|null }>} */
const tokenCache = new Map();

function cacheKey({ connectionId, credentialVersion, grantType, scope, tokenUrl }) {
  return [
    connectionId || 'none',
    credentialVersion ?? 'none',
    grantType || 'client_credentials',
    scope || '',
    tokenUrl || '',
  ].join('|');
}

/** Invalidate cached tokens for a connection (optionally a specific version). */
export function invalidateCoopTokenCache(connectionId, credentialVersion = null) {
  if (!connectionId) return;
  const prefix = String(connectionId);
  for (const key of [...tokenCache.keys()]) {
    if (!key.startsWith(`${prefix}|`)) continue;
    if (credentialVersion == null || key.split('|')[1] === String(credentialVersion)) {
      tokenCache.delete(key);
    }
  }
}

export class CoopAuthService {
  /**
   * @param {object} opts
   * @param {string} opts.tokenUrl
   * @param {string} opts.consumerKey
   * @param {string} opts.consumerSecret
   * @param {string|null} [opts.scope] trusted server config only
   * @param {string|null} [opts.connectionId]
   * @param {number|null} [opts.credentialVersion]
   */
  constructor({
    tokenUrl,
    consumerKey,
    consumerSecret,
    scope = null,
    connectionId = null,
    credentialVersion = null,
  }) {
    this.tokenUrl = tokenUrl;
    this.consumerKey = consumerKey;
    this.consumerSecret = consumerSecret;
    this.scope = scope || null;
    this.connectionId = connectionId ? String(connectionId) : null;
    this.credentialVersion = credentialVersion != null ? Number(credentialVersion) : null;
    this.grantType = 'client_credentials';
  }

  _key() {
    return cacheKey({
      connectionId: this.connectionId,
      credentialVersion: this.credentialVersion,
      grantType: this.grantType,
      scope: this.scope,
      tokenUrl: this.tokenUrl,
    });
  }

  async getAccessToken() {
    if (!this.consumerKey || !this.consumerSecret) {
      throw Errors.BankAuthFailed('Co-op Consumer Key and Consumer Secret are required');
    }
    if (!this.tokenUrl) {
      throw Errors.BankAuthFailed('Co-op token endpoint is not configured');
    }

    const key = this._key();
    const entry = tokenCache.get(key);
    if (entry?.token && Date.now() < entry.expiresAt - EXPIRY_SAFETY_MARGIN_MS) {
      return entry.token;
    }
    if (entry?.inflight) {
      return entry.inflight;
    }

    const inflight = this._requestNewToken()
      .then((result) => {
        tokenCache.set(key, {
          token: result.token,
          expiresAt: result.expiresAt,
          inflight: null,
        });
        return result.token;
      })
      .catch((err) => {
        const current = tokenCache.get(key);
        if (current?.inflight === inflight) {
          tokenCache.delete(key);
        }
        throw err;
      });

    tokenCache.set(key, {
      token: entry?.token || null,
      expiresAt: entry?.expiresAt || 0,
      inflight,
    });

    return inflight;
  }

  async _requestNewToken() {
    const basicAuth = Buffer.from(`${this.consumerKey}:${this.consumerSecret}`).toString('base64');
    const params = new URLSearchParams();
    params.set('grant_type', 'client_credentials');
    if (this.scope) {
      params.set('scope', this.scope);
    }

    try {
      const response = await axios.post(this.tokenUrl, params.toString(), {
        headers: {
          Authorization: `Basic ${basicAuth}`,
          'Content-Type': 'application/x-www-form-urlencoded',
        },
        timeout: 15000,
        validateStatus: () => true,
      });

      if (response.status < 200 || response.status >= 300) {
        logger.warn(
          { status: response.status, connectionId: this.connectionId },
          'Co-op token request failed'
        );
        throw Errors.BankAuthFailed('Failed to authenticate with Co-op Bank');
      }

      const data = response.data || {};
      const accessToken = data.access_token;
      if (!accessToken || typeof accessToken !== 'string') {
        throw Errors.BankAuthFailed('Co-op token response missing access_token');
      }
      const tokenType = String(data.token_type || '').toLowerCase();
      if (tokenType && tokenType !== 'bearer') {
        throw Errors.BankAuthFailed('Co-op returned unexpected token type');
      }

      // Require provider-supplied positive expires_in. Do not invent 3600.
      const expiresInSec = Number(data.expires_in);
      if (!Number.isFinite(expiresInSec) || expiresInSec <= 0) {
        throw Errors.BankAuthFailed('Co-op token response missing usable expires_in');
      }

      const expiresAt = Date.now() + expiresInSec * 1000;
      logger.info(
        {
          expiresInSec,
          connectionId: this.connectionId,
          credentialVersion: this.credentialVersion,
        },
        'Co-op access token acquired'
      );
      return { token: accessToken, expiresAt };
    } catch (err) {
      if (err?.code && err?.statusCode) throw err;
      logger.warn(
        { error: err.message, connectionId: this.connectionId },
        'Co-op authentication failed'
      );
      throw Errors.BankAuthFailed('Failed to authenticate with Co-op Bank');
    }
  }

  invalidate() {
    tokenCache.delete(this._key());
  }
}
