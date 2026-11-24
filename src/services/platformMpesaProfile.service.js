// Superadmin-controlled merchant profiles (PAYBILL / BUY_GOODS_TILL) and estate mappings.
// Daraja Consumer Key/Secret remain Tycoon platform configuration, never profile fields.
// Creating a profile NEVER registers it with Daraja and never grants capability/operational state.
import mongoose from 'mongoose';
import { Client } from '../models/Client.js';
import { Estate } from '../models/Estate.js';
import { MpesaMerchantProfile } from '../models/MpesaMerchantProfile.js';
import { MpesaMerchantProfileEstate } from '../models/MpesaMerchantProfileEstate.js';
import { MpesaCollectionReference } from '../models/MpesaCollectionReference.js';
import { inspectMpesaIndexes } from '../utils/mpesaIndexReadiness.js';
import { encryptionUtil } from '../utils/encryption.js';
import { Errors } from '../utils/errors.js';
import { auditRequired } from './audit.service.js';
import { safeMerchantProfile, mappingsByProfile } from './platformIntegrations.service.js';
import { maskMsisdn, normalizeKenyanMsisdn } from './mpesa/mpesaRegistration.service.js';
import { getCallbackConfig } from './mpesa/darajaCallbackConfig.service.js';
import { MERCHANT_TYPE } from './mpesa/daraja.constants.js';
import { env } from '../config/environment.js';

async function requireReadiness() {
  const report = await inspectMpesaIndexes();
  if (report?.gates?.merchantRegistration !== true || report?.gates?.profileEstateMapping !== true) {
    throw Errors.ServiceUnavailable('M-PESA merchant uniqueness indexes are not ready');
  }
}

export async function loadProfileView(clientId, profileId) {
  const profile = await MpesaMerchantProfile.findOne({ _id: profileId, clientId }).lean();
  if (!profile) throw Errors.NotFound('Merchant profile not found');
  const [mappingMap, client] = await Promise.all([
    mappingsByProfile([profile]),
    Client.findById(clientId).select('isActive').lean(),
  ]);
  const mappings = mappingMap.get(String(profile._id)) || [];
  return safeMerchantProfile(profile, undefined, mappings, client?.isActive === true);
}

async function assertActiveClient(clientId, session) {
  const client = await Client.findById(clientId).select('_id name isActive').session(session).lean();
  if (!client) throw Errors.NotFound('Client not found');
  if (client.isActive !== true) throw Errors.InvalidRequest('M-PESA profiles can only be configured for an active client');
  return client;
}

async function assertClientEstates(clientId, estateIds, session) {
  const ids = [...new Set(estateIds.map(String))];
  const found = await Estate.find({ _id: { $in: ids }, clientId }).select('_id').session(session).lean();
  if (found.length !== ids.length) throw Errors.InvalidRequest('Every selected estate must belong to this client');
  return ids;
}

export const platformMpesaProfileService = {
  async create(clientId, { merchantType = MERCHANT_TYPE.BUY_GOODS_TILL, businessShortCode, displayName, estateIds, estateId }, actor, reqMeta = {}) {
    if (!mongoose.isValidObjectId(clientId)) throw Errors.NotFound('Client not found');
    const shortcode = String(businessShortCode || '').trim();
    if (!/^\d{1,20}$/.test(shortcode)) throw Errors.InvalidRequest('Business shortcode must contain digits only');
    if (!Object.values(MERCHANT_TYPE).includes(merchantType)) throw Errors.InvalidRequest('Unsupported merchant type');
    const wanted = estateIds?.length ? estateIds : (estateId ? [estateId] : []);
    if (!wanted.length) throw Errors.InvalidRequest('Select at least one estate');

    // autoIndex is off: the migration-controlled global unique index must exist so concurrent
    // duplicates fail closed.
    await requireReadiness();

    const session = await mongoose.startSession();
    let profile;
    try {
      await session.withTransaction(async () => {
        const client = await assertActiveClient(clientId, session);
        const ids = await assertClientEstates(clientId, wanted, session);
        const [created] = await MpesaMerchantProfile.create([{
          clientId, provider: 'SAFARICOM', merchantType,
          displayName: displayName?.trim() || null,
          businessShortCode: shortcode,
          operationalState: 'DRAFT', callbackCapability: 'UNKNOWN', pullCapability: 'UNKNOWN',
          c2bRegistrationState: 'NONE', pullRegistrationState: 'NONE',
          createdByUserId: actor?._id || null, updatedByUserId: actor?._id || null,
        }], { session });
        profile = created;
        await MpesaMerchantProfileEstate.create(ids.map((id) => ({
          merchantProfileId: created._id, clientId, estateId: id, status: 'ACTIVE', source: 'SUPERADMIN',
          createdByUserId: actor?._id || null,
        })), { session, ordered: true });
        await auditRequired({
          clientId, userId: actor?._id, action: 'MPESA_MERCHANT_PROFILE_CREATED', resource: 'MpesaMerchantProfile',
          resourceId: String(created._id),
          description: `Created a DRAFT M-PESA ${merchantType} profile for client "${client.name}"`,
          metadata: { merchantType, businessShortCode: shortcode, operationalState: 'DRAFT', estateIds: ids },
          ipAddress: reqMeta.ip, userAgent: reqMeta.userAgent,
        }, { session });
      });
    } catch (err) {
      if (err?.code === 11000) throw Errors.Conflict('This shortcode is already registered on the platform');
      throw err;
    } finally {
      await session.endSession();
    }
    return loadProfileView(clientId, profile._id);
  },

  async get(clientId, profileId) {
    return loadProfileView(clientId, profileId);
  },

  async addEstate(clientId, profileId, estateId, actor, reqMeta = {}) {
    await requireReadiness();
    const session = await mongoose.startSession();
    try {
      await session.withTransaction(async () => {
        const profile = await MpesaMerchantProfile.findOne({ _id: profileId, clientId }).session(session).select('_id').lean();
        if (!profile) throw Errors.NotFound('Merchant profile not found');
        await assertClientEstates(clientId, [estateId], session);
        await MpesaMerchantProfileEstate.updateOne(
          { merchantProfileId: profileId, estateId },
          { $set: { status: 'ACTIVE', deactivatedAt: null, deactivatedByUserId: null },
            $setOnInsert: { clientId, source: 'SUPERADMIN', createdByUserId: actor?._id || null } },
          { upsert: true, session },
        );
        await auditRequired({
          clientId, estateId, userId: actor?._id, action: 'MPESA_MERCHANT_ESTATE_MAPPED', resource: 'MpesaMerchantProfile',
          resourceId: String(profileId), description: 'Mapped an estate to an M-PESA merchant profile',
          metadata: { estateId: String(estateId) }, ipAddress: reqMeta.ip, userAgent: reqMeta.userAgent,
        }, { session });
      });
    } finally {
      await session.endSession();
    }
    return loadProfileView(clientId, profileId);
  },

  async removeEstate(clientId, profileId, estateId, actor, reqMeta = {}) {
    const session = await mongoose.startSession();
    try {
      await session.withTransaction(async () => {
        const live = await MpesaCollectionReference.exists({ merchantProfileId: profileId, clientId, estateId, status: 'ACTIVE' }).session(session);
        if (live) throw Errors.Conflict('Retire this estate\'s active collection references before removing the mapping');
        const r = await MpesaMerchantProfileEstate.updateOne(
          { merchantProfileId: profileId, clientId, estateId, status: 'ACTIVE' },
          { $set: { status: 'INACTIVE', deactivatedAt: new Date(), deactivatedByUserId: actor?._id || null } },
          { session },
        );
        if (r.matchedCount !== 1) throw Errors.NotFound('Active mapping not found');
        await auditRequired({
          clientId, estateId, userId: actor?._id, action: 'MPESA_MERCHANT_ESTATE_UNMAPPED', resource: 'MpesaMerchantProfile',
          resourceId: String(profileId), description: 'Deactivated an estate mapping on an M-PESA merchant profile',
          metadata: { estateId: String(estateId) }, ipAddress: reqMeta.ip, userAgent: reqMeta.userAgent,
        }, { session });
      });
    } finally {
      await session.endSession();
    }
    return loadProfileView(clientId, profileId);
  },

  /** Capture the Pull nominated MSISDN. Encrypted at rest; only a masked value is ever returned. */
  async setPullNominatedNumber(clientId, profileId, msisdn, actor, reqMeta = {}) {
    const normalized = normalizeKenyanMsisdn(msisdn);
    if (!normalized) throw Errors.InvalidRequest('Enter a valid Safaricom number');
    const row = await MpesaMerchantProfile.findOneAndUpdate(
      { _id: profileId, clientId, pullRegistrationState: { $in: ['NONE', 'REJECTED'] } },
      { $set: {
        pullNominatedMsisdnEncrypted: encryptionUtil.encrypt(normalized),
        pullNominatedMsisdnMasked: maskMsisdn(normalized),
        pullNominatedMsisdnSetAt: new Date(),
        updatedByUserId: actor?._id || null,
      } },
      { new: true },
    );
    if (!row) throw Errors.Conflict('Profile not found or Pull registration already in progress/completed');
    // The number is deliberately absent from metadata.
    await auditRequired({
      clientId, userId: actor?._id, action: 'MPESA_PULL_NUMBER_SET', resource: 'MpesaMerchantProfile',
      resourceId: String(profileId), description: 'Captured the Pull nominated number',
      metadata: {}, ipAddress: reqMeta.ip, userAgent: reqMeta.userAgent,
    });
    return loadProfileView(clientId, profileId);
  },

  callbackConfig() {
    const cfg = getCallbackConfig(env);
    return cfg.configured
      ? { configured: true, configId: cfg.configId, version: cfg.version, environment: cfg.environment,
        confirmationUrl: cfg.confirmationUrl, validationUrl: cfg.validationUrl, pullResultsUrl: cfg.pullResultsUrl }
      : { configured: false, reason: cfg.reason, environment: cfg.environment };
  },
};
