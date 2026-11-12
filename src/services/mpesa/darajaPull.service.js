// src/services/mpesa/darajaPull.service.js
//
// G5.3 — Pull Transactions registration, query, lease, and result ingestion.
// Query method: POST (SDK secondary evidence; portal GET discrepancy remains BLOCKED).
// Do not implement speculative dual GET/POST paths.
// Checkpoint advances only after durable ingestion of returned rows.

import crypto from 'crypto';
import axios from 'axios';
import { DARAJA_PATHS, INGESTION_SOURCE, PULL_REGISTER_CODE } from './daraja.constants.js';
import { normalizePullTransactionRow } from './mpesaNormalize.js';
import {
  persistIngestionEvent,
  claimIngestionEvent,
  processClaimedEvent,
} from './mpesaIngestion.service.js';
import { MpesaPullCheckpoint } from '../../models/MpesaPullCheckpoint.js';
import { MpesaMerchantProfile } from '../../models/MpesaMerchantProfile.js';
import { logger } from '../../config/logger.js';

export async function registerPull(
  oauthClient,
  { shortCode, nominatedNumber, callBackUrl, merchantProfileId = null, http = axios }
) {
  if (!oauthClient) throw new Error('OAuth client required');
  if (!shortCode || !nominatedNumber || !callBackUrl) {
    throw new Error('shortCode, nominatedNumber and callBackUrl are required');
  }

  let profile = null;
  if (merchantProfileId) {
    profile = await MpesaMerchantProfile.findById(merchantProfileId);
    if (!profile) throw new Error('merchant profile not found');
    await MpesaMerchantProfile.updateOne(
      { _id: profile._id },
      { $set: { pullRegistrationState: 'REQUESTED' } }
    );
  }

  const accessToken = await oauthClient.getAccessToken();
  const url = `${oauthClient.baseURL}${DARAJA_PATHS.pullRegister}`;

  let response;
  try {
    response = await http.post(
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
  } catch (err) {
    if (profile) {
      await MpesaMerchantProfile.updateOne(
        { _id: profile._id, pullRegistrationState: 'REQUESTED' },
        { $set: { pullRegistrationState: 'UNCERTAIN' } }
      );
    }
    return {
      httpStatus: 0,
      body: null,
      ok: false,
      registrationState: 'UNCERTAIN',
      error: 'network_or_timeout',
    };
  }

  const responseCode = String(
    response.data?.ResponseCode
      ?? response.data?.responseCode
      ?? response.data?.Responsecode
      ?? ''
  );
  let registrationState = 'REJECTED';
  if (responseCode === PULL_REGISTER_CODE.SUCCESS) registrationState = 'ACCEPTED';
  else if (responseCode === PULL_REGISTER_CODE.ALREADY_REGISTERED) {
    registrationState = 'ALREADY_REGISTERED';
  } else if (response.status >= 200 && response.status < 300) {
    registrationState = 'ACCEPTED';
  }

  if (profile) {
    await MpesaMerchantProfile.updateOne(
      { _id: profile._id, pullRegistrationState: 'REQUESTED' },
      {
        $set: {
          pullRegistrationState: registrationState,
          lastPullRegisteredAt:
            registrationState === 'ACCEPTED' || registrationState === 'ALREADY_REGISTERED'
              ? new Date()
              : null,
          pullCapability:
            registrationState === 'ACCEPTED' || registrationState === 'ALREADY_REGISTERED'
              ? 'VERIFIED'
              : profile.pullCapability,
        },
      }
    );
  }

  return {
    httpStatus: response.status,
    body: response.data ?? null,
    responseCode,
    alreadyRegistered: responseCode === PULL_REGISTER_CODE.ALREADY_REGISTERED,
    ok: registrationState === 'ACCEPTED' || registrationState === 'ALREADY_REGISTERED',
    registrationState,
  };
}

export async function queryPullTransactions(
  oauthClient,
  { shortCode, startDate, endDate, offSetValue = '0', http = axios }
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
 * Extract transaction rows and classify response shape.
 * empty_valid: known envelope with zero rows
 * unsupported: body present but no recognized row array
 */
export function extractPullRows(body) {
  if (body == null) return { shape: 'empty_body', rows: [] };
  if (typeof body !== 'object') return { shape: 'unsupported', rows: [] };
  if (Array.isArray(body)) {
    return { shape: body.length ? 'rows' : 'empty_valid', rows: body };
  }
  for (const key of ['Response', 'transactions', 'Transactions', 'data']) {
    if (Array.isArray(body[key])) {
      const rows = body[key];
      return { shape: rows.length ? 'rows' : 'empty_valid', rows };
    }
  }
  return { shape: 'unsupported', rows: [] };
}

/**
 * Persist + process each Pull row through the shared durable inbox.
 * Failed row persistence prevents allPersisted=true and checkpoint advancement.
 */
export async function ingestPullPayload(body, { sourceChannel = INGESTION_SOURCE.PULL_QUERY } = {}) {
  const extracted = extractPullRows(body);
  const rows = extracted.rows;
  const results = [];
  let persistFailures = 0;

  if (extracted.shape === 'unsupported') {
    return {
      rowCount: 0,
      persistFailures: 0,
      allPersisted: false,
      responseShape: 'unsupported',
      results: [],
    };
  }

  for (const row of rows) {
    const normalized = normalizePullTransactionRow(row, { sourceChannel });
    try {
      const event = await persistIngestionEvent(normalized);
      const claim = await claimIngestionEvent(event._id);
      let processResult = {};
      if (claim) {
        processResult = await processClaimedEvent(claim.event, claim.leaseToken, normalized);
      }
      results.push({
        receiptNumber: normalized.receiptNumber,
        ok: normalized.ok,
        persisted: true,
        transactionId: processResult.transaction?._id ?? null,
        conflict: Boolean(processResult.conflict),
        quarantined: Boolean(processResult.quarantined),
      });
    } catch (err) {
      persistFailures += 1;
      logger.error({ err: err.message }, 'Pull row persist/process failed');
      results.push({
        receiptNumber: normalized.receiptNumber,
        ok: false,
        persisted: false,
        error: 'persistence_failed',
      });
    }
  }

  return {
    rowCount: rows.length,
    persistFailures,
    allPersisted: persistFailures === 0,
    responseShape: extracted.shape,
    results,
  };
}

export async function ensurePullCheckpoint(merchantProfile) {
  try {
    await MpesaPullCheckpoint.create({
      clientId: merchantProfile.clientId,
      merchantProfileId: merchantProfile._id,
      businessShortCode: merchantProfile.businessShortCode,
      lastOffsetValue: '0',
      lastQueryStatus: 'IDLE',
    });
  } catch (err) {
    if (err?.code !== 11000) throw err;
  }
  return MpesaPullCheckpoint.findOne({ merchantProfileId: merchantProfile._id });
}

/**
 * Acquire lease with fencing token. Returns BUSY when another worker holds a live lease.
 * Avoids upsert collision against unique merchantProfileId index.
 */
export async function acquirePullLease(merchantProfile, ownerId, { ttlMs = 120_000 } = {}) {
  await ensurePullCheckpoint(merchantProfile);
  const now = new Date();
  const expires = new Date(now.getTime() + ttlMs);
  const fenceToken = crypto.randomBytes(12).toString('hex');

  const updated = await MpesaPullCheckpoint.findOneAndUpdate(
    {
      merchantProfileId: merchantProfile._id,
      $or: [
        { leaseExpiresAt: null },
        { leaseExpiresAt: { $lte: now } },
        { leaseOwner: null },
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
        lastErrorCode: fenceToken,
      },
    },
    { new: true }
  );

  if (!updated || updated.leaseOwner !== ownerId) {
    return { status: 'BUSY', checkpoint: null, fenceToken: null };
  }
  return { status: 'ACQUIRED', checkpoint: updated, fenceToken };
}

export async function releasePullLease(
  merchantProfileId,
  ownerId,
  fenceToken,
  { status = 'IDLE' } = {}
) {
  return MpesaPullCheckpoint.findOneAndUpdate(
    {
      merchantProfileId,
      leaseOwner: ownerId,
      lastErrorCode: fenceToken,
    },
    {
      $set: {
        leaseOwner: null,
        leaseExpiresAt: null,
        lastQueryStatus: status,
      },
    },
    { new: true }
  );
}

export async function advancePullCheckpoint(
  merchantProfileId,
  ownerId,
  fenceToken,
  { windowStartAt, windowEndAt, lastOffsetValue }
) {
  return MpesaPullCheckpoint.findOneAndUpdate(
    {
      merchantProfileId,
      leaseOwner: ownerId,
      lastErrorCode: fenceToken,
    },
    {
      $set: {
        windowStartAt,
        windowEndAt,
        lastOffsetValue: String(lastOffsetValue),
        lastQueryStatus: 'SUCCEEDED',
      },
    },
    { new: true }
  );
}
