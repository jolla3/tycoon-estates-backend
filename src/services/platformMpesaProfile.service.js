// Superadmin-controlled creation of a client Till profile.
// Daraja Consumer Key/Secret remain Tycoon platform configuration, never profile fields.
import mongoose from 'mongoose';
import { Client } from '../models/Client.js';
import { Estate } from '../models/Estate.js';
import { MpesaMerchantProfile } from '../models/MpesaMerchantProfile.js';
import { inspectMpesaIndexes } from '../utils/mpesaIndexReadiness.js';
import { Errors } from '../utils/errors.js';
import { auditRequired } from './audit.service.js';
import { safeMerchantProfile } from './platformIntegrations.service.js';

export const platformMpesaProfileService = {
  async create(clientId, { businessShortCode, displayName, estateId }, actor, reqMeta = {}) {
    if (!mongoose.isValidObjectId(clientId)) throw Errors.NotFound('Client not found');
    const client = await Client.findById(clientId).select('_id name isActive').lean();
    if (!client) throw Errors.NotFound('Client not found');
    if (client.isActive !== true) throw Errors.InvalidRequest('M-PESA profiles can only be configured for an active client');

    const estate = await Estate.findOne({ _id: estateId, clientId }).select('_id name').lean();
    if (!estate) throw Errors.InvalidRequest('Select an estate belonging to this client');

    // Schema autoIndex is disabled. The migration-controlled unique index is
    // required before profile creation so concurrent duplicate shortcodes fail closed.
    const report = await inspectMpesaIndexes();
    if (report?.gates?.merchantRegistration !== true) {
      throw Errors.ServiceUnavailable('M-PESA merchant profile uniqueness index is not ready');
    }

    const shortcode = String(businessShortCode || '').trim();
    if (!/^\\d{1,20}$/.test(shortcode)) throw Errors.InvalidRequest('Business shortcode must contain digits only');

    const session = await mongoose.startSession();
    let profile;
    try {
      await session.withTransaction(async () => {
        const [created] = await MpesaMerchantProfile.create([{
          clientId,
          provider: 'SAFARICOM',
          merchantType: 'BUY_GOODS_TILL',
          displayName: displayName?.trim() || null,
          businessShortCode: shortcode,
          estateId: estate._id,
          operationalState: 'DRAFT',
          callbackCapability: 'UNKNOWN',
          pullCapability: 'UNKNOWN',
          c2bRegistrationState: 'NONE',
          pullRegistrationState: 'NONE',
          createdByUserId: actor?._id || null,
          updatedByUserId: actor?._id || null,
        }], { session });
        profile = created;
        await auditRequired({
          clientId,
          estateId: estate._id,
          userId: actor?._id,
          action: 'MPESA_MERCHANT_PROFILE_CREATED',
          resource: 'MpesaMerchantProfile',
          resourceId: String(created._id),
          description: `Created a DRAFT M-PESA Till profile for client "${client.name}"`,
          metadata: {
            merchantType: created.merchantType,
            businessShortCode: created.businessShortCode,
            operationalState: created.operationalState,
            estateId: String(estate._id),
          },
          ipAddress: reqMeta.ip,
          userAgent: reqMeta.userAgent,
        }, { session });
      });
    } catch (err) {
      if (err?.code === 11000) throw Errors.Conflict('This Till shortcode is already registered for this client');
      throw err;
    } finally {
      await session.endSession();
    }
    return safeMerchantProfile(profile.toObject());
  },
};
