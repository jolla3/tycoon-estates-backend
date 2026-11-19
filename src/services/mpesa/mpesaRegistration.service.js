// Explicit, audited Daraja registration actions (C2B and Pull are separate).
// Profile creation NEVER registers. Registration success != callback capability verified !=
// operational. No secrets are stored or returned; the Pull nominated number is decrypted only
// here, only for the outbound provider request, and never logged or audited.
import { MpesaMerchantProfile } from '../../models/MpesaMerchantProfile.js';
import { env } from '../../config/environment.js';
import { createDarajaOAuthClientFromEnv } from './darajaOAuth.client.js';
import { registerC2bUrls } from './darajaC2b.service.js';
import { registerPull } from './darajaPull.service.js';
import { getCallbackConfig } from './darajaCallbackConfig.service.js';
import { C2B_RESPONSE_TYPE } from './daraja.constants.js';
import { encryptionUtil } from '../../utils/encryption.js';
import { auditRequired } from '../audit.service.js';
import { Errors } from '../../utils/errors.js';

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

export const mpesaRegistrationService = {
  async registerC2b({ clientId, profileId, actor, reqMeta = {}, http, oauthClient }) {
    const cfg = requireCallbackConfig();
    const profile = await load(clientId, profileId);
    if (BLOCKING.includes(profile.c2bRegistrationState)) {
      throw Errors.Conflict(`C2B registration is ${profile.c2bRegistrationState}; reconcile it before another attempt`);
    }
    // Atomic claim: two concurrent clicks cannot both send a provider request.
    const claimed = await MpesaMerchantProfile.updateOne(
      { _id: profile._id, clientId, c2bRegistrationState: { $nin: BLOCKING } },
      { $set: { c2bRegistrationState: 'REQUESTED' } },
    );
    if (claimed.modifiedCount !== 1) throw Errors.Conflict('C2B registration is already in progress');
    const attemptedAt = new Date();
    const result = await registerC2bUrls(oauthClient || requireOAuth(), {
      shortCode: profile.businessShortCode,
      confirmationUrl: cfg.confirmationUrl,
      validationUrl: cfg.validationUrl,
      responseType: C2B_RESPONSE_TYPE.COMPLETED,
      merchantProfileId: profile._id,
      ...(http ? { http } : {}),
    });
    const success = result.registrationState === 'ACCEPTED' || result.registrationState === 'ALREADY_REGISTERED';
    await MpesaMerchantProfile.updateOne({ _id: profile._id }, { $set: {
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
      updatedByUserId: actor?._id || null,
    } });
    await auditRequired({
      clientId, userId: actor?._id, action: 'MPESA_C2B_REGISTRATION_ATTEMPTED', resource: 'MpesaMerchantProfile',
      resourceId: String(profile._id), description: 'Explicit C2B URL registration attempted',
      metadata: { registrationState: result.registrationState, configVersion: cfg.version, environment: cfg.environment },
      ipAddress: reqMeta.ip, userAgent: reqMeta.userAgent,
    });
    return { registrationState: result.registrationState, configVersion: cfg.version };
  },

  async registerPull({ clientId, profileId, actor, reqMeta = {}, http, oauthClient }) {
    const cfg = requireCallbackConfig();
    const profile = await load(clientId, profileId, '+pullNominatedMsisdnEncrypted');
    if (!profile.pullNominatedMsisdnEncrypted) throw Errors.InvalidRequest('Nominated Pull number has not been captured');
    if (profile.pullRegistrationState !== 'NONE' && profile.pullRegistrationState !== 'REJECTED') {
      // Pull registration is documented as one-time; REQUESTED/UNCERTAIN need reconciliation.
      throw Errors.Conflict(`Pull registration is ${profile.pullRegistrationState}; no further attempt is allowed without reconciliation`);
    }
    let nominated;
    try { nominated = encryptionUtil.decrypt(profile.pullNominatedMsisdnEncrypted); } catch { throw Errors.ServiceUnavailable('Nominated number cannot be read'); }
    const claimed = await MpesaMerchantProfile.updateOne(
      { _id: profile._id, clientId, pullRegistrationState: { $in: ['NONE', 'REJECTED'] } },
      { $set: { pullRegistrationState: 'REQUESTED' } },
    );
    if (claimed.modifiedCount !== 1) throw Errors.Conflict('Pull registration is already in progress');
    const attemptedAt = new Date();
    const result = await registerPull(oauthClient || requireOAuth(), {
      shortCode: profile.businessShortCode,
      nominatedNumber: nominated,
      callBackUrl: cfg.pullResultsUrl,
      merchantProfileId: profile._id,
      ...(http ? { http } : {}),
    });
    nominated = null; // eslint-disable-line no-useless-assignment
    await MpesaMerchantProfile.updateOne({ _id: profile._id }, { $set: {
      'pullRegistration.environment': cfg.environment,
      'pullRegistration.configId': cfg.configId,
      'pullRegistration.configVersion': cfg.version,
      'pullRegistration.callbackUrl': cfg.pullResultsUrl,
      'pullRegistration.attemptedAt': attemptedAt,
      'pullRegistration.providerResponseStatus': result.responseCode ? String(result.responseCode).slice(0, 40) : null,
      ...(result.ok ? { 'pullRegistration.succeededAt': new Date() } : {}),
      updatedByUserId: actor?._id || null,
    } });
    await auditRequired({
      clientId, userId: actor?._id, action: 'MPESA_PULL_REGISTRATION_ATTEMPTED', resource: 'MpesaMerchantProfile',
      resourceId: String(profile._id), description: 'Explicit Pull registration attempted',
      metadata: { registrationState: result.registrationState, configVersion: cfg.version, environment: cfg.environment },
      ipAddress: reqMeta.ip, userAgent: reqMeta.userAgent,
    });
    return { registrationState: result.registrationState, configVersion: cfg.version };
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
