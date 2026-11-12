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
} from './mpesaIngestion.service.js';
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

  const ok = response.status >= 200 && response.status < 300;
  let registrationState = ok ? 'ACCEPTED' : 'REJECTED';
  const desc = String(
    response.data?.ResponseDescription ?? response.data?.errorMessage ?? ''
  ).toLowerCase();
  if (desc.includes('already')) registrationState = 'ALREADY_REGISTERED';

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

export async function handleC2bValidation(_body) {
  return { ResultCode: 0, ResultDesc: 'Accepted' };
}
