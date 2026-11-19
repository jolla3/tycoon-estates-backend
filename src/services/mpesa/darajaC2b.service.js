// src/services/mpesa/darajaC2b.service.js
//
// G5.3 — Controlled C2B URL registration + confirmation handling.
// Registration is never performed on application boot.
// Acknowledgement follows durable event persistence only.

import axios from 'axios';
import crypto from 'crypto';
import { DARAJA_PATHS, C2B_RESPONSE_TYPE } from './daraja.constants.js';
import { normalizeC2bConfirmation } from './mpesaNormalize.js';
import {
  persistIngestionEvent,
  claimIngestionEvent,
  processClaimedEvent,
  resolveMerchantProfilesByShortCode,
} from './mpesaIngestion.service.js';
import { resolveReference } from './mpesaReference.service.js';
import { MpesaMerchantProfile } from '../../models/MpesaMerchantProfile.js';
import { logger } from '../../config/logger.js';

export async function registerC2bUrls(
  oauthClient,
  {
    shortCode,
    confirmationUrl,
    validationUrl,
    responseType = C2B_RESPONSE_TYPE.COMPLETED,
    merchantProfileId = null,
    http = axios,
  }
) {
  if (!oauthClient) throw new Error('OAuth client required');
  if (!shortCode || !confirmationUrl || !validationUrl) {
    throw new Error('shortCode, confirmationUrl and validationUrl are required');
  }

  const attemptToken = crypto.randomBytes(8).toString('hex');
  let profile = null;
  if (merchantProfileId) {
    profile = await MpesaMerchantProfile.findById(merchantProfileId);
    if (!profile) throw new Error('merchant profile not found');
    if (String(profile.businessShortCode) !== String(shortCode)) {
      throw new Error('shortCode does not match merchant profile');
    }
    await MpesaMerchantProfile.updateOne(
      { _id: profile._id },
      { $set: { c2bRegistrationState: 'REQUESTED' } }
    );
  }

  const accessToken = await oauthClient.getAccessToken();
  const registerPath = process.env.DARAJA_C2B_REGISTER_PATH || DARAJA_PATHS.c2bRegisterUrl;
  const url = `${oauthClient.baseURL}${registerPath}`;

  let response;
  try {
    response = await http.post(
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
  } catch (err) {
    if (profile) {
      await MpesaMerchantProfile.updateOne(
        { _id: profile._id, c2bRegistrationState: 'REQUESTED' },
        { $set: { c2bRegistrationState: 'UNCERTAIN' } }
      );
    }
    return {
      httpStatus: 0,
      body: null,
      ok: false,
      registrationState: 'UNCERTAIN',
      attemptToken,
      error: 'network_or_timeout',
    };
  }

  const responseCode = String(
    response.data?.ResponseCode ?? response.data?.responseCode ?? ''
  ).trim();
  const httpAccepted = response.status >= 200 && response.status < 300;
  const providerAccepted = ['0', '00000000'].includes(responseCode);
  const ok = httpAccepted && providerAccepted;
  let registrationState = ok ? 'ACCEPTED' : 'REJECTED';
  const desc = String(
    response.data?.ResponseDescription ?? response.data?.errorMessage ?? ''
  ).toLowerCase();
  if (httpAccepted && providerAccepted && desc.includes('already')) {
    registrationState = 'ALREADY_REGISTERED';
  }

  if (profile) {
    await MpesaMerchantProfile.updateOne(
      { _id: profile._id, c2bRegistrationState: 'REQUESTED' },
      {
        $set: {
          c2bRegistrationState: registrationState,
          lastC2bRegisteredAt:
            ok || registrationState === 'ALREADY_REGISTERED' ? new Date() : null,
        },
      }
    );
  }

  return {
    httpStatus: response.status,
    body: response.data ?? null,
    responseCode,
    ok: ok || registrationState === 'ALREADY_REGISTERED',
    registrationState,
    attemptToken,
  };
}

export async function handleC2bConfirmation(body) {
  const normalized = normalizeC2bConfirmation(body);
  let event;
  try {
    event = await persistIngestionEvent(normalized);
  } catch (err) {
    logger.error({ err: err.message }, 'C2B confirmation persist failed');
    return {
      ack: { ResultCode: 1, ResultDesc: 'Persist failed' },
      httpStatus: 500,
      ingestion: { persisted: false, error: 'persistence_failed' },
    };
  }

  const ack = { ResultCode: 0, ResultDesc: 'Accepted' };
  try {
    const claim = await claimIngestionEvent(event._id);
    if (claim) {
      const result = await processClaimedEvent(claim.event, claim.leaseToken, normalized);
      return {
        ack,
        httpStatus: 200,
        ingestion: {
          persisted: true,
          eventId: event._id,
          transactionId: result.transaction?._id ?? null,
          quarantined: Boolean(result.quarantined),
          conflict: Boolean(result.conflict),
        },
      };
    }
    return {
      ack,
      httpStatus: 200,
      ingestion: { persisted: true, eventId: event._id, deferred: true },
    };
  } catch (err) {
    logger.error({ err: err.message }, 'C2B confirmation processing failed after persist');
    return {
      ack,
      httpStatus: 200,
      ingestion: { persisted: true, eventId: event._id, processingError: err.message },
    };
  }
}

/**
 * External validation is optional, needs Safaricom enablement and is NOT enabled for any Tycoon
 * merchant. If it is ever invoked this handler is read-only and fails closed: it accepts only an
 * exactly-resolved eligible merchant (and, for PayBill, an exactly-resolved ACTIVE reference).
 * The shortcode in the body is a lookup key, not authentication; callback authenticity remains
 * unproven, which is why this never mutates anything and never creates a receipt.
 * Result codes follow the Daraja C2B error table (C2B00012 invalid account, C2B00016 other).
 */
export async function handleC2bValidation(body) {
  const accept = { ResultCode: '0', ResultDesc: 'Accepted' };
  try {
    const payload = body && typeof body === 'object' ? body : {};
    const shortCode = payload.BusinessShortCode != null ? String(payload.BusinessShortCode).trim() : '';
    const resolution = await resolveMerchantProfilesByShortCode(shortCode);
    if (resolution.status !== 'exact') return { ResultCode: 'C2B00016', ResultDesc: 'Rejected' };
    const profile = resolution.profile;
    if (profile.operationalState !== 'ACTIVE') return { ResultCode: 'C2B00016', ResultDesc: 'Rejected' };
    if (profile.merchantType === 'PAYBILL') {
      const r = await resolveReference({ profile, billRefNumber: payload.BillRefNumber });
      if (r.state !== 'ok') return { ResultCode: 'C2B00012', ResultDesc: 'Rejected' };
    }
    return accept;
  } catch (err) {
    logger.error({ err: err.message }, 'C2B validation failed closed');
    return { ResultCode: 'C2B00016', ResultDesc: 'Rejected' };
  }
}
