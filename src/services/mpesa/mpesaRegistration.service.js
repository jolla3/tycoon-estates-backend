// Explicit, audited Daraja registration actions (C2B and Pull are separate).
// Profile creation NEVER registers. Registration success != callback capability verified !=
// operational. No secrets are stored or returned; the Pull nominated number is decrypted only
// here, only for the outbound provider request, and never logged or audited.
import axios from 'axios';
import { MpesaMerchantProfile } from '../../models/MpesaMerchantProfile.js';
import { env } from '../../config/environment.js';
import { createDarajaOAuthClientFromEnv } from './darajaOAuth.client.js';
import { registerC2bUrls } from './darajaC2b.service.js';
import { registerPull } from './darajaPull.service.js';
import { getCallbackConfig } from './darajaCallbackConfig.service.js';
import { C2B_RESPONSE_TYPE, PULL_REGISTRATION_ELIGIBILITY } from './daraja.constants.js';
import { logger } from '../../config/logger.js';
import { encryptionUtil } from '../../utils/encryption.js';
import { auditRequired } from '../audit.service.js';
import { Errors, AppError } from '../../utils/errors.js';

const BLOCKING = ['REQUESTED', 'UNCERTAIN'];

export function maskMsisdn(msisdn) {
  const s = String(msisdn);
  return `${s.slice(0, 4)}${'*'.repeat(Math.max(0, s.length - 7))}${s.slice(-3)}`;
}

/** Kenyan MSISDN in 2547XXXXXXXX / 2541XXXXXXXX form (accepts 07.., 01.., +254..). */
export function normalizeKenyanMsisdn(raw) {
  const digits = String(raw || '').replace(/[\s()-]/g, '').replace(/^\+/, '');
  let n = digits;
  if (/^0[17]\d{8}$/.test(n)) n = `254${n.slice(1)}`;
  return /^254[17]\d{8}$/.test(n) ? n : null;
}

function requireCallbackConfig() {
  const cfg = getCallbackConfig(env);
  if (!cfg.configured) throw Errors.ServiceUnavailable(`Daraja callback configuration unavailable: ${cfg.reason}`);
  return cfg;
}

function requireOAuth() {
  let client;
  try { client = createDarajaOAuthClientFromEnv(env); } catch { client = null; }
  if (!client) throw Errors.ServiceUnavailable('Daraja credentials are not configured on the platform');
  return client;
}

async function load(clientId, profileId, extra = '') {
  const profile = await MpesaMerchantProfile.findOne({ _id: profileId, clientId }).select(extra);
  if (!profile) throw Errors.NotFound('Merchant profile not found');
  return profile;
}

function conversationId(body) {
  const v = body?.OriginatorCoversationID ?? body?.OriginatorConversationID ?? body?.ConversationID ?? null;
  return v == null ? null : String(v).slice(0, 80);
}

/**
 * Wrap an http client so we know whether a provider request was actually handed to the network.
 * Anything thrown before that point is a PRE-SEND failure (safe to release the claim); anything
 * after it is an UNCERTAIN provider outcome (needs operator reconciliation).
 */
function trackSend(http) {
  const state = { sent: false };
  const inner = http || axios;
  return { state, http: { post: (...args) => { state.sent = true; return inner.post(...args); } } };
}

async function bestEffortAudit(entry) {
  try { await auditRequired(entry); } catch (err) { logger.warn({ err: err?.message, action: entry.action }, 'registration audit failed'); }
}

/**
 * Shared lifecycle for one explicit registration attempt:
 *   1. local preflight (config, credentials, token) happens BEFORE any state change
 *   2. atomic claim -> REQUESTED, then a durable "sending" audit; if that audit cannot be written
 *      nothing was sent, so the claim is released
 *   3. send; the outcome is persisted by THIS service (the low-level client is not given the
 *      profile id, so it can never leave a stale REQUESTED)
 *   4. network timeout / post-send error => UNCERTAIN, requiring reconciliation before any retry
 * A returned success changes registration evidence only; it never makes anything operational.
 */
async function runAttempt({ kind, profile, clientId, actor, reqMeta, cfg, oauth, prior, claimFilter, send, evidenceFor }) {
  const stateField = kind === 'c2b' ? 'c2bRegistrationState' : 'pullRegistrationState';
  const upper = kind.toUpperCase();
  const notSent = async (reason) => {
    await bestEffortAudit({
      clientId, userId: actor?._id, action: `MPESA_${upper}_REGISTRATION_NOT_SENT`, resource: 'MpesaMerchantProfile',
      resourceId: String(profile._id), description: `${upper} registration not sent (${reason})`,
      metadata: { reason, configVersion: cfg.version }, ipAddress: reqMeta.ip, userAgent: reqMeta.userAgent,
    });
  };

  // Token acquisition is part of preflight: failure here must not leave REQUESTED behind.
  try { await oauth.getAccessToken(); } catch {
    await notSent('token_acquisition_failed');
    throw Errors.ServiceUnavailable('Daraja authentication failed; no registration request was sent');
  }

  const claimed = await MpesaMerchantProfile.updateOne(
    { _id: profile._id, clientId, ...claimFilter }, { $set: { [stateField]: 'REQUESTED' } },
  );
  if (claimed.modifiedCount !== 1) throw Errors.Conflict(`${upper} registration is already in progress`);
  const release = () => MpesaMerchantProfile.updateOne(
    { _id: profile._id, [stateField]: 'REQUESTED' }, { $set: { [stateField]: prior } },
  );

  const attemptedAt = new Date();
  try {
    await auditRequired({
      clientId, userId: actor?._id, action: `MPESA_${upper}_REGISTRATION_SENDING`, resource: 'MpesaMerchantProfile',
      resourceId: String(profile._id), description: `Explicit ${upper} registration is being sent`,
      metadata: { configVersion: cfg.version, environment: cfg.environment, priorState: prior },
      ipAddress: reqMeta.ip, userAgent: reqMeta.userAgent,
    });
  } catch (err) {
    await release(); // nothing was sent, no durable evidence => no attempt
    throw err;
  }

  const tracker = trackSend(send.http);
  let result;
  try {
    result = await send.run(oauth, tracker.http);
  } catch (err) {
    if (!tracker.state.sent) {
      await release();
      await notSent('pre_send_error');
      throw Errors.ServiceUnavailable('Registration could not be prepared; no request was sent');
    }
    result = { registrationState: 'UNCERTAIN', ok: false, error: 'post_send_error', responseCode: null, body: null };
  }

  let state = ['ACCEPTED', 'ALREADY_REGISTERED', 'REJECTED', 'UNCERTAIN'].includes(result.registrationState)
    ? result.registrationState : 'UNCERTAIN';
  // A 5xx/408/429 after submission does not prove the provider ignored the request.
  if (state === 'REJECTED' && (result.httpStatus >= 500 || result.httpStatus === 408 || result.httpStatus === 429)) state = 'UNCERTAIN';
  const success = state === 'ACCEPTED' || state === 'ALREADY_REGISTERED';
  await MpesaMerchantProfile.updateOne({ _id: profile._id }, { $set: {
    [stateField]: state,
    ...evidenceFor({ result, attemptedAt, success }),
    updatedByUserId: actor?._id || null,
  } });
  await bestEffortAudit({
    clientId, userId: actor?._id, action: `MPESA_${upper}_REGISTRATION_ATTEMPTED`, resource: 'MpesaMerchantProfile',
    resourceId: String(profile._id), description: `Explicit ${upper} registration attempted`,
    metadata: { registrationState: state, configVersion: cfg.version, environment: cfg.environment },
    ipAddress: reqMeta.ip, userAgent: reqMeta.userAgent,
  });
  return { registrationState: state, configVersion: cfg.version };
}

export const mpesaRegistrationService = {
  async registerC2b({ clientId, profileId, actor, reqMeta = {}, http, oauthClient }) {
    const cfg = requireCallbackConfig();
    const oauth = oauthClient || requireOAuth();
    const profile = await load(clientId, profileId);
    if (BLOCKING.includes(profile.c2bRegistrationState)) {
      throw Errors.Conflict(`C2B registration is ${profile.c2bRegistrationState}; reconcile it before another attempt`);
    }
    return runAttempt({
      kind: 'c2b', profile, clientId, actor, reqMeta, cfg, oauth,
      prior: profile.c2bRegistrationState,
      claimFilter: { c2bRegistrationState: { $nin: BLOCKING } },
      send: {
        http,
        run: (client, h) => registerC2bUrls(client, {
          shortCode: profile.businessShortCode,
          confirmationUrl: cfg.confirmationUrl,
          validationUrl: cfg.validationUrl,
          responseType: C2B_RESPONSE_TYPE.COMPLETED,
          http: h, // no merchantProfileId: this service owns the state transitions
        }),
      },
      evidenceFor: ({ result, attemptedAt, success }) => ({
        'c2bRegistration.environment': cfg.environment,
        'c2bRegistration.configId': cfg.configId,
        'c2bRegistration.configVersion': cfg.version,
        'c2bRegistration.confirmationUrl': cfg.confirmationUrl,
        'c2bRegistration.validationUrl': cfg.validationUrl,
        'c2bRegistration.responseType': C2B_RESPONSE_TYPE.COMPLETED,
        'c2bRegistration.attemptedAt': attemptedAt,
        'c2bRegistration.providerResponseCode': result.responseCode ? String(result.responseCode).slice(0, 40) : null,
        'c2bRegistration.providerConversationId': conversationId(result.body),
        ...(success ? { 'c2bRegistration.succeededAt': new Date() } : {}),
      }),
    });
  },

  async registerPull({ clientId, profileId, actor, reqMeta = {}, http, oauthClient, eligibility = PULL_REGISTRATION_ELIGIBILITY }) {
    const cfg = requireCallbackConfig();
    const profile = await load(clientId, profileId, '+pullNominatedMsisdnEncrypted');
    // Fail closed BEFORE credentials, token, decryption or any state change.
    const elig = eligibility[profile.merchantType];
    if (!elig?.verified) {
      throw new AppError(
        'MPESA_PULL_ELIGIBILITY_UNVERIFIED',
        `Pull registration is not enabled for ${profile.merchantType}: no official provider evidence or controlled sandbox observation establishes eligibility`,
        409,
      );
    }
    if (!profile.pullNominatedMsisdnEncrypted) throw Errors.InvalidRequest('Nominated Pull number has not been captured');
    if (profile.pullRegistrationState !== 'NONE' && profile.pullRegistrationState !== 'REJECTED') {
      // Pull registration is documented as one-time; REQUESTED/UNCERTAIN need reconciliation.
      throw Errors.Conflict(`Pull registration is ${profile.pullRegistrationState}; no further attempt is allowed without reconciliation`);
    }
    const oauth = oauthClient || requireOAuth();
    let nominated;
    try { nominated = encryptionUtil.decrypt(profile.pullNominatedMsisdnEncrypted); } catch { throw Errors.ServiceUnavailable('Nominated number cannot be read'); }
    try {
      return await runAttempt({
        kind: 'pull', profile, clientId, actor, reqMeta, cfg, oauth,
        prior: profile.pullRegistrationState,
        claimFilter: { pullRegistrationState: { $in: ['NONE', 'REJECTED'] } },
        send: {
          http,
          run: (client, h) => registerPull(client, {
            shortCode: profile.businessShortCode, nominatedNumber: nominated, callBackUrl: cfg.pullResultsUrl, http: h,
          }),
        },
        evidenceFor: ({ result, attemptedAt, success }) => ({
          'pullRegistration.environment': cfg.environment,
          'pullRegistration.configId': cfg.configId,
          'pullRegistration.configVersion': cfg.version,
          'pullRegistration.callbackUrl': cfg.pullResultsUrl,
          'pullRegistration.attemptedAt': attemptedAt,
          'pullRegistration.providerResponseStatus': result.responseCode ? String(result.responseCode).slice(0, 40) : null,
          ...(success ? { 'pullRegistration.succeededAt': new Date(), lastPullRegisteredAt: new Date() } : {}),
        }),
      });
    } finally {
      nominated = null; // eslint-disable-line no-useless-assignment
    }
  },

  /**
   * Operator attestation that an UNCERTAIN/REQUESTED attempt was checked against the Daraja
   * portal/provider. Moves to NONE (not registered: retry allowed) or ALREADY_REGISTERED.
   */
  async reconcile({ clientId, profileId, kind, outcome, actor, reqMeta = {} }) {
    if (!['c2b', 'pull'].includes(kind)) throw Errors.InvalidRequest('Unknown registration kind');
    if (!['NOT_REGISTERED', 'REGISTERED'].includes(outcome)) throw Errors.InvalidRequest('Unknown reconciliation outcome');
    const field = kind === 'c2b' ? 'c2bRegistrationState' : 'pullRegistrationState';
    const next = outcome === 'REGISTERED' ? 'ALREADY_REGISTERED' : 'NONE';
    const row = await MpesaMerchantProfile.findOneAndUpdate(
      { _id: profileId, clientId, [field]: { $in: BLOCKING } },
      { $set: { [field]: next, updatedByUserId: actor?._id || null } },
      { new: true },
    );
    if (!row) throw Errors.Conflict('Registration is not awaiting reconciliation');
    await auditRequired({
      clientId, userId: actor?._id, action: 'MPESA_REGISTRATION_RECONCILED', resource: 'MpesaMerchantProfile',
      resourceId: String(profileId), description: `Operator reconciled ${kind} registration`,
      metadata: { kind, outcome }, ipAddress: reqMeta.ip, userAgent: reqMeta.userAgent,
    });
    return { registrationState: next };
  },
};
