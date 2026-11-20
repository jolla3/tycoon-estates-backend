// src/services/banking/providers/coop/coop.client.js
// Thin axios wrapper. Does not log raw response bodies, tokens, or account numbers.

import axios from 'axios';
import crypto from 'crypto';
import { Errors } from '../../../../utils/errors.js';
import { isCoopSuccess, getCoopMessageCode } from './coop.schemas.js';
import { logger } from '../../../../config/logger.js';

export function generateMessageReference() {
  return crypto.randomBytes(10).toString('hex').slice(0, 20);
}

/**
 * @param {object} opts
 * @param {boolean} [opts.allowNonSuccessMessageCode] when true, return body for caller classification
 */
export async function coopPost({
  baseUrl,
  path,
  token,
  body,
  timeout = 15000,
  allowNonSuccessMessageCode = false,
}) {
  if (
    baseUrl
    && !String(baseUrl).startsWith('https://')
    && process.env.NODE_ENV !== 'test'
    && process.env.JEST_WORKER_ID == null
  ) {
    throw Errors.BankProviderUnavailable('Co-op resource URL must use HTTPS');
  }

  let response;
  try {
    response = await axios.post(`${baseUrl}${path}`, body, {
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
      },
      timeout,
      validateStatus: () => true,
    });
  } catch (err) {
    if (err.code === 'ECONNABORTED' || err.message?.includes('timeout')) {
      logger.warn({ path }, 'Co-op API timeout');
      throw Errors.BankProviderUnavailable('Co-op Bank request timed out');
    }
    logger.warn({ path, error: err.message }, 'Co-op API network failure');
    throw Errors.BankProviderUnavailable('Could not reach Co-op Bank');
  }

  const status = response.status;
  if (status === 401 || status === 403) {
    logger.warn({ path, status }, 'Co-op API authentication/authorization failure');
    throw Errors.BankAuthFailed('Co-op Bank rejected the access token or scope');
  }
  if (status === 429) {
    logger.warn({ path, status }, 'Co-op API rate limited');
    throw Errors.BankProviderUnavailable('Co-op Bank rate limit exceeded');
  }
  if (status < 200 || status >= 300) {
    logger.warn({ path, status }, 'Co-op API HTTP error');
    throw Errors.BankProviderUnavailable(`Co-op Bank returned HTTP ${status}`);
  }

  const data = response.data;
  if (allowNonSuccessMessageCode) {
    return data;
  }

  if (!isCoopSuccess(data)) {
    const code = getCoopMessageCode(data);
    logger.warn({ path, messageCode: code }, 'Co-op returned a non-success MessageCode');
    throw Errors.BankProviderUnavailable('Co-op Bank rejected the request');
  }

  return data;
}
