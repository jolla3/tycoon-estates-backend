// src/services/mpesa/mpesaLifecycle.service.js
//
// Explicit, audited Superadmin lifecycle operations for an M-PESA merchant profile:
//   activate: DRAFT|NOT_READY -> ACTIVE
//   suspend : ACTIVE          -> SUSPENDED   (reason required)
//   resume  : SUSPENDED       -> ACTIVE      (C2B readiness re-checked)
//
// Guarantees:
//   * Only this service writes operationalState. Registration success never activates.
//   * Readiness is evaluated here from stored state (C2B registration, VERIFIED callback
//     capability, active estate mapping). Pull is optional and never a blocker.
//   * Each call must echo the profile's lifecycleRevision. The write is a single atomic
//     compare-and-set on (state, revision), so a stale or concurrent update fails with 409
//     instead of overwriting.
//   * The audit record commits or rolls back atomically with the state change (auditRequired).
//   * Callback capability and Pull capability are not changed by any lifecycle operation, and
//     nothing here enables posting by any route other than the existing ACTIVE gate.
import mongoose from 'mongoose';
import { Client } from '../../models/Client.js';
import { MpesaMerchantProfile } from '../../models/MpesaMerchantProfile.js';
import { getCallbackConfig } from './darajaCallbackConfig.service.js';
import { auditRequired } from '../audit.service.js';
import { safeMerchantProfile, mappingsByProfile } from '../platformIntegrations.service.js';
import { activationBlockers, resumeBlockers } from './mpesaReadiness.js';
import { AppError, Errors } from '../../utils/errors.js';

// Legacy documents have no lifecycleRevision; revision 0 must match a missing field.
const revisionFilter = (rev) => (rev === 0 ? { $in: [0, null] } : rev);

const OPS = {
  activate: {
    from: ['DRAFT', 'NOT_READY'], to: 'ACTIVE', action: 'MPESA_MERCHANT_ACTIVATED',
    blockers: activationBlockers, requireReason: false, needsActiveClient: true,
    stamp: (by, now) => ({ 'lifecycle.activatedAt': now, 'lifecycle.activatedByUserId': by }),
  },
  suspend: {
    from: ['ACTIVE'], to: 'SUSPENDED', action: 'MPESA_MERCHANT_SUSPENDED',
    blockers: (p) => (p.operationalState === 'ACTIVE' ? [] : [`OPERATIONAL_STATE_${p.operationalState}`]),
    requireReason: true, needsActiveClient: false,
    stamp: (by, now, reason) => ({ 'lifecycle.suspendedAt': now, 'lifecycle.suspendedByUserId': by, 'lifecycle.suspensionReason': reason }),
  },
  resume: {
    from: ['SUSPENDED'], to: 'ACTIVE', action: 'MPESA_MERCHANT_RESUMED',
    blockers: resumeBlockers, requireReason: false, needsActiveClient: true,
    stamp: (by, now) => ({ 'lifecycle.resumedAt': now, 'lifecycle.resumedByUserId': by, 'lifecycle.suspensionReason': null }),
  },
};

async function run(op, { clientId, profileId, expectedRevision, reason, actor, reqMeta = {} }) {
  const cfg = OPS[op];
  if (!mongoose.isValidObjectId(clientId) || !mongoose.isValidObjectId(profileId)) throw Errors.NotFound('Merchant profile not found');
  if (!Number.isInteger(expectedRevision) || expectedRevision < 0) throw Errors.InvalidRequest('expectedRevision is required');
  const cleanReason = typeof reason === 'string' ? reason.trim().slice(0, 500) : '';
  if (cfg.requireReason && cleanReason.length < 3) throw Errors.InvalidRequest('A reason is required');
  if (!actor?._id) throw Errors.AuthRequired('Authenticated Superadmin required');

  const session = await mongoose.startSession();
  try {
    await session.withTransaction(async () => {
      const profile = await MpesaMerchantProfile.findOne({ _id: profileId, clientId }).session(session).lean();
      if (!profile) throw Errors.NotFound('Merchant profile not found');
      if ((profile.lifecycleRevision ?? 0) !== expectedRevision) {
        throw Errors.Conflict('This profile changed since you loaded it. Refresh and review before retrying.');
      }
      const client = await Client.findById(clientId).select('isActive').session(session).lean();
      if (!client) throw Errors.NotFound('Client not found');
      if (cfg.needsActiveClient && client.isActive !== true) {
        throw Errors.InvalidRequest('The client must be active');
      }
      // Same eligible-estate definition as every read model (annotateMappingEligibility): an ACTIVE
      // mapping whose Estate exists, is active and belongs to this same client.
      const mapped = (await mappingsByProfile([profile], { session })).get(String(profile._id)) || [];
      const activeEstateCount = mapped.filter((m) => m.estateEligible === true).length;

      // Re-evaluated against the CURRENT callback configuration at submit time.
      const blockers = cfg.blockers(profile, {
        activeEstateCount,
        clientActive: client.isActive === true,
        config: getCallbackConfig(),
      });
      if (blockers.length) {
        throw new AppError('MPESA_LIFECYCLE_BLOCKED', `Cannot ${op} this merchant profile`, 409, { blockers });
      }

      const now = new Date();
      // Atomic compare-and-set on state AND revision: a concurrent writer makes this match 0 docs.
      const updated = await MpesaMerchantProfile.findOneAndUpdate(
        { _id: profile._id, clientId, operationalState: { $in: cfg.from }, lifecycleRevision: revisionFilter(expectedRevision) },
        { $set: { operationalState: cfg.to, updatedByUserId: actor._id, lifecycleRevision: expectedRevision + 1, ...cfg.stamp(actor._id, now, cleanReason) } },
        { new: true, session },
      );
      if (!updated) throw Errors.Conflict('This profile changed since you loaded it. Refresh and review before retrying.');

      await auditRequired({
        clientId, userId: actor._id, action: cfg.action, resource: 'MpesaMerchantProfile', resourceId: String(profile._id),
        description: `Superadmin ${op} of M-PESA ${profile.merchantType} profile`,
        metadata: {
          from: profile.operationalState, to: cfg.to, revision: expectedRevision + 1,
          businessShortCode: profile.businessShortCode,
          c2bRegistrationState: profile.c2bRegistrationState, callbackCapability: profile.callbackCapability,
          ...(cleanReason ? { reason: cleanReason } : {}),
        },
        ipAddress: reqMeta.ip, userAgent: reqMeta.userAgent,
      }, { session });
    });
  } finally {
    await session.endSession();
  }

  const [fresh, client] = await Promise.all([
    MpesaMerchantProfile.findOne({ _id: profileId, clientId }).lean(),
    Client.findById(clientId).select('isActive').lean(),
  ]);
  if (!fresh) throw Errors.NotFound('Merchant profile not found');
  const mappings = (await mappingsByProfile([fresh])).get(String(fresh._id)) || [];
  return safeMerchantProfile(fresh, undefined, mappings, client?.isActive === true);
}

export const mpesaLifecycleService = {
  activate: (args) => run('activate', args),
  suspend: (args) => run('suspend', args),
  resume: (args) => run('resume', args),
};
