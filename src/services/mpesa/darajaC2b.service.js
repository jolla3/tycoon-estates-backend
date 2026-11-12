// src/services/mpesa/darajaC2b.service.js
//
// G5.3 — Controlled C2B URL registration + confirmation handling.
// Registration is never performed on application boot.

import axios from 'axios';
import { DARAJA_PATHS, C2B_RESPONSE_TYPE } from './daraja.constants.js';
import { normalizeC2bConfirmation } from './mpesaNormalize.js';
import { ingestNormalizedObservation } from './mpesaIngestion.service.js';
import { logger } from '../../config/logger.js';

/**
 * Register C2B validation/confirmation URLs for a shortcode.
 * Operator-triggered only.
 */
export async function registerC2bUrls(
  oauthClient,
  {
    shortCode,
    confirmationUrl,
    validationUrl,
    responseType = C2B_RESPONSE_TYPE.COMPLETED,
    http = axios,
  }
) {
  if (!oauthClient) throw new Error('OAuth client required');
  if (!shortCode || !confirmationUrl || !validationUrl) {
    throw new Error('shortCode, confirmationUrl and validationUrl are required');
  }

  const accessToken = await oauthClient.getAccessToken();
  const url = `${oauthClient.baseURL}${DARAJA_PATHS.c2bRegisterUrl}`;

  const response = await http.post(
    url,
    {
      ShortCode: String(shortCode),
      ResponseType: responseType,
      ConfirmationURL: confirmationUrl,
      ValidationURL: validationUrl,
    },
    {
      headers: {
        Authorization: `Bearer ${accessToken}`,
        'Content-Type': 'application/json',
      },
      timeout: 20_000,
      validateStatus: () => true,
    }
  );

  return {
    httpStatus: response.status,
    body: response.data ?? null,
    ok: response.status >= 200 && response.status < 300,
  };
}

/**
 * Handle inbound C2B confirmation: normalize + durable ingest.
 * Always returns an acknowledgement object for the HTTP layer.
 * Missing BillRefNumber is accepted for Buy Goods.
 */
export async function handleC2bConfirmation(body) {
  const normalized = normalizeC2bConfirmation(body);

  try {
    const result = await ingestNormalizedObservation(normalized);
    return {
      ack: { ResultCode: 0, ResultDesc: 'Accepted' },
      ingestion: {
        eventId: result.event?._id ?? null,
        transactionId: result.transaction?._id ?? null,
        duplicateEvent: Boolean(result.duplicateEvent),
        quarantined: Boolean(result.quarantined || result.conflict),
        conflict: Boolean(result.conflict),
      },
    };
  } catch (err) {
    logger.error({ err: err.message }, 'C2B confirmation ingestion failed');
    // Still acknowledge to reduce provider retry storms; event may be absent.
    // Operators must rely on Pull reconciliation for recovery.
    return {
      ack: { ResultCode: 0, ResultDesc: 'Accepted' },
      ingestion: {
        eventId: null,
        transactionId: null,
        duplicateEvent: false,
        quarantined: true,
        conflict: false,
        error: 'persistence_failed',
      },
    };
  }
}

/**
 * Validation callback: external validation is not assumed enabled.
 * Default policy accepts (ResultCode 0) so Till payments are not blocked
 * when validation URL is registered but external validation is off/unused.
 */
export async function handleC2bValidation(_body) {
  return { ResultCode: 0, ResultDesc: 'Accepted' };
}
