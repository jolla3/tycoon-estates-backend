// src/services/mpesa/darajaPull.service.js
//
// G5.3 — Pull Transactions registration and query.
// Query method is POST (SECONDARY evidence). Sync vs callback-only response
// shape remains partially BLOCKED/UNKNOWN — both paths are supported.

import axios from 'axios';
import { DARAJA_PATHS, INGESTION_SOURCE, PULL_REGISTER_CODE } from './daraja.constants.js';
import { normalizePullTransactionRow } from './mpesaNormalize.js';
import { ingestNormalizedObservation } from './mpesaIngestion.service.js';
import { MpesaPullCheckpoint } from '../../models/MpesaPullCheckpoint.js';
import { logger } from '../../config/logger.js';

/**
 * One-time Pull registration (operator-triggered).
 */
export async function registerPull(
  oauthClient,
  { shortCode, nominatedNumber, callBackUrl, http = axios }
) {
  if (!oauthClient) throw new Error('OAuth client required');
  if (!shortCode || !nominatedNumber || !callBackUrl) {
    throw new Error('shortCode, nominatedNumber and callBackUrl are required');
  }

  const accessToken = await oauthClient.getAccessToken();
  const url = `${oauthClient.baseURL}${DARAJA_PATHS.pullRegister}`;

  const response = await http.post(
    url,
    {
      ShortCode: String(shortCode),
      RequestType: 'Pull',
      NominatedNumber: String(nominatedNumber),
      CallBackURL: callBackUrl,
    },
    {
      headers: {
        Authorization: `Bearer ${accessToken}`,
        'Content-Type': 'application/json',
        'Accept-Encoding': 'application/json',
      },
      timeout: 20_000,
      validateStatus: () => true,
    }
  );

  const responseCode = String(
    response.data?.ResponseCode
      ?? response.data?.responseCode
      ?? response.data?.Responsecode
      ?? ''
  );

  return {
    httpStatus: response.status,
    body: response.data ?? null,
    responseCode,
    alreadyRegistered: responseCode === PULL_REGISTER_CODE.ALREADY_REGISTERED,
    ok:
      (response.status >= 200 && response.status < 300)
      || responseCode === PULL_REGISTER_CODE.SUCCESS
      || responseCode === PULL_REGISTER_CODE.ALREADY_REGISTERED,
  };
}

/**
 * Query Pull Transactions for a window. Does not advance checkpoint unless
 * `commitCheckpoint` is true and ingestion of returned rows succeeds.
 */
export async function queryPullTransactions(
  oauthClient,
  {
    shortCode,
    startDate,
    endDate,
    offSetValue = '0',
    http = axios,
  }
) {
  if (!oauthClient) throw new Error('OAuth client required');
  if (!shortCode || !startDate || !endDate) {
    throw new Error('shortCode, startDate and endDate are required');
  }

  const accessToken = await oauthClient.getAccessToken();
  const url = `${oauthClient.baseURL}${DARAJA_PATHS.pullQuery}`;

  const response = await http.post(
    url,
    {
      ShortCode: String(shortCode),
      StartDate: startDate,
      EndDate: endDate,
      OffSetValue: String(offSetValue),
    },
    {
      headers: {
        Authorization: `Bearer ${accessToken}`,
        'Content-Type': 'application/json',
      },
      timeout: 30_000,
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
 * Extract transaction row arrays from heterogeneous Pull response shapes.
 */
export function extractPullRows(body) {
  if (!body || typeof body !== 'object') return [];
  if (Array.isArray(body)) return body;
  if (Array.isArray(body.Response)) return body.Response;
  if (Array.isArray(body.transactions)) return body.transactions;
  if (Array.isArray(body.Transactions)) return body.Transactions;
  if (Array.isArray(body.data)) return body.data;
  return [];
}

/**
 * Ingest all rows from a Pull query or callback payload.
 */
export async function ingestPullPayload(body, { sourceChannel = INGESTION_SOURCE.PULL_QUERY } = {}) {
  const rows = extractPullRows(body);
  const results = [];
  for (const row of rows) {
    const normalized = normalizePullTransactionRow(row, { sourceChannel });
    try {
      // eslint-disable-next-line no-await-in-loop
      const r = await ingestNormalizedObservation(normalized);
      results.push({
        receiptNumber: normalized.receiptNumber,
        ok: normalized.ok,
        transactionId: r.transaction?._id ?? null,
        conflict: Boolean(r.conflict),
        quarantined: Boolean(r.quarantined || r.conflict),
      });
    } catch (err) {
      logger.error({ err: err.message }, 'Pull row ingestion failed');
      results.push({
        receiptNumber: normalized.receiptNumber,
        ok: false,
        error: 'persistence_failed',
      });
    }
  }
  return { rowCount: rows.length, results };
}

/**
 * Acquire a simple lease on the checkpoint document for a shortcode profile.
 */
export async function acquirePullLease(merchantProfile, ownerId, { ttlMs = 120_000 } = {}) {
  const now = new Date();
  const expires = new Date(now.getTime() + ttlMs);
  const updated = await MpesaPullCheckpoint.findOneAndUpdate(
    {
      merchantProfileId: merchantProfile._id,
      $or: [
        { leaseExpiresAt: null },
        { leaseExpiresAt: { $lte: now } },
        { leaseOwner: ownerId },
      ],
    },
    {
      $set: {
        clientId: merchantProfile.clientId,
        businessShortCode: merchantProfile.businessShortCode,
        leaseOwner: ownerId,
        leaseExpiresAt: expires,
        lastQueryStatus: 'RUNNING',
        lastQueryAt: now,
      },
      $setOnInsert: {
        lastOffsetValue: '0',
      },
    },
    { upsert: true, new: true }
  );
  if (!updated || updated.leaseOwner !== ownerId) {
    return null;
  }
  return updated;
}
