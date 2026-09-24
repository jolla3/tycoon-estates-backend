// src/services/banking/providers/coop/coop.client.js
//
// Thin axios wrapper: injects the Bearer token, generates
// MessageReference (required + unique on every documented request body,
// 1–27 chars), and centralizes the "MessageCode !== 0 is an error"
// response convention shared by every Co-op Connect endpoint.

import axios from 'axios';
import crypto from 'crypto';
import { Errors } from '../../../../utils/errors.js';
import { isCoopSuccess } from './coop.schemas.js';
import { logger } from '../../../../config/logger.js';

/** 1–27 chars per the documented MessageReference constraint. */
export function generateMessageReference() {
  return crypto.randomBytes(10).toString('hex').slice(0, 20);
}

export async function coopPost({ baseUrl, path, token, body, timeout = 15000 }) {
  let response;
  try {
    response = await axios.post(`${baseUrl}${path}`, body, {
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      timeout,
    });
  } catch (err) {
    if (err.response) {
      logger.error({ path, status: err.response.status, data: err.response.data }, 'Co-op API call failed');
      throw Errors.BankProviderUnavailable(`Co-op Bank returned HTTP ${err.response.status}`);
    }
    logger.error({ path, error: err.message }, 'Co-op API call failed (network)');
    throw Errors.BankProviderUnavailable('Could not reach Co-op Bank');
  }

  if (!isCoopSuccess(response.data)) {
    logger.warn({ path, messageCode: response.data?.MessageCode, description: response.data?.MessageDescription }, 'Co-op returned a non-success MessageCode');
    throw Errors.BankProviderUnavailable(response.data?.MessageDescription || 'Co-op Bank rejected the request');
  }

  return response.data;
}
