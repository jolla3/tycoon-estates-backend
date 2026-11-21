// src/services/mpesa/mpesaSubmissionLink.service.js — Tenant submission link lifecycle.
// One link per {clientId, estateId, tenantId}. Raw token is returned exactly once
// (create/rotate) and is never stored. Rotation/revocation use linkVersion CAS.
// Protected SMS for the tenant-facing URL is queued in the same transaction when
// phone + merchant Till prerequisites are available; otherwise the link still
// issues and the blocked reason is audited.
import mongoose from 'mongoose';
import { MpesaSubmissionLink } from '../../models/MpesaSubmissionLink.js';
import { resolveTillMerchant } from './mpesaMerchantMapping.service.js';
import { Tenant } from '../../models/Tenant.js';
import { audit } from '../audit.service.js';
import {
  cancelQueuedForLink,
  queueProtectedSms,
  G5_ONBOARDING_TYPE,
  G5_ONBOARDING_VERSION,
} from '../g5ProtectedSms.service.js';
import { generateBearerToken, digestToken } from '../../utils/g5Token.js';
import { Errors } from '../../utils/errors.js';
import { env } from '../../config/environment.js';
import { logger } from '../../config/logger.js';

/**
 * The ACTIVE Till (actively mapped to this estate) a link uses. A link bound to a merchant
 * profile uses exactly that profile; an unbound link needs exactly one candidate.
 */
export async function resolveOperationalMerchant(clientId, estateId, { merchantProfileId = null } = {}) {
  const { merchant } = await resolveTillMerchant(clientId, estateId, { merchantProfileId });
  return merchant;
}

function view(link, merchant) {
  return {
    id: link._id, tenantId: link.tenantId, estateId: link.estateId, status: link.status,
    version: link.linkVersion, rotatedAt: link.rotatedAt, revokedAt: link.revokedAt,
    operational: link.status === 'ACTIVE' && Boolean(merchant),
  };
}

async function assertTenant(clientId, estateId, tenantId) {
  const t = await Tenant.findOne({ _id: tenantId, clientId, estateId }).select('_id phone');
  if (!t) throw Errors.TenantNotFound();
  return t;
}

function buildOnboardingBody({ tillCode, token }) {
  const base = env.FRONTEND_URL;
  const url = `${base}/pay#t=${token}`;
  const till = tillCode ? ` Till ${tillCode}.` : '';
  return `Tycoon Estates: submit your M-PESA Buy Goods confirmation here.${till} ${url}`;
}

async function queueOnboardingIfPossible({
  clientId, estateId, tenant, link, token, merchant, session, actor,
}) {
  const phone = tenant?.phone && String(tenant.phone).trim();
  const tillCode = merchant?.businessShortCode ? String(merchant.businessShortCode) : null;
  if (!phone || !tillCode || !env.FRONTEND_URL) {
    const reason = !phone ? 'tenant_phone_missing' : !tillCode ? 'merchant_till_unavailable' : 'frontend_url_missing';
    await audit({
      clientId, estateId, userId: actor?.userId,
      action: 'G5_LINK_SMS_BLOCKED', resource: 'MpesaSubmissionLink',
      resourceId: link._id,
      metadata: { tenantId: String(tenant._id), version: link.linkVersion, reason },
      ipAddress: actor?.ip, userAgent: actor?.userAgent,
    });
    logger.info({ reason, linkId: String(link._id) }, 'G5 onboarding SMS not queued');
    return { queued: false, reason };
  }
  const body = buildOnboardingBody({ tillCode, token });
  const idempotencyKey = `onboard:${String(link._id)}:v${link.linkVersion}`;
  const r = await queueProtectedSms({
    clientId, estateId, tenantId: tenant._id,
    phone, body,
    type: G5_ONBOARDING_TYPE,
    notificationVersion: G5_ONBOARDING_VERSION,
    idempotencyKey,
    linkId: link._id,
    linkVersion: link.linkVersion,
    session,
  });
  return { queued: r.created, reason: null };
}

export const mpesaSubmissionLinkService = {
  async inspect({ clientId, estateId, tenantId }) {
    await assertTenant(clientId, estateId, tenantId);
    const link = await MpesaSubmissionLink.findOne({ clientId, estateId, tenantId });
    if (!link) return null;
    return view(link, await resolveOperationalMerchant(clientId, estateId, { merchantProfileId: link.merchantProfileId }));
  },

  /** Create, or rotate an existing link (also re-activates a revoked one). Returns the raw token once. */
  async issue({ clientId, estateId, tenantId, actor, merchantProfileId = null }) {
    const tenant = await assertTenant(clientId, estateId, tenantId);
    const resolution = await resolveTillMerchant(clientId, estateId, { merchantProfileId });
    if (merchantProfileId && !resolution.merchant) {
      throw Errors.InvalidRequest('Selected merchant is not an active Till mapped to this estate');
    }
    if (resolution.ambiguous) {
      throw Errors.Conflict('Several Tills are active for this estate; select a merchant profile');
    }
    const merchant = resolution.merchant;
    const token = generateBearerToken();
    const tokenDigest = digestToken(token);

    const session = await mongoose.startSession();
    let link;
    let action = 'G5_LINK_ROTATED';
    let smsMeta = { queued: false, reason: null };
    try {
      await session.withTransaction(async () => {
        link = await MpesaSubmissionLink.findOne({ clientId, estateId, tenantId }).session(session);
        if (!link) {
          try {
            const created = await MpesaSubmissionLink.create([{
              clientId, estateId, tenantId, merchantProfileId: merchant?._id || null,
              tokenDigest, createdByUserId: actor?.userId || null,
            }], { session });
            link = created[0];
            action = 'G5_LINK_CREATED';
          } catch (err) {
            if (err?.code === 11000) throw Errors.Conflict('Link was created concurrently; retry');
            throw err;
          }
        } else {
          const updated = await MpesaSubmissionLink.findOneAndUpdate(
            { _id: link._id, clientId, estateId, tenantId, linkVersion: link.linkVersion },
            {
              $set: {
                tokenDigest, status: 'ACTIVE', revokedAt: null, rotatedAt: new Date(),
                merchantProfileId: merchant?._id || null, lastRotatedByUserId: actor?.userId || null,
              },
              $inc: { linkVersion: 1 },
            },
            { new: true, session }
          );
          if (!updated) throw Errors.Conflict('Link changed concurrently; retry');
          await cancelQueuedForLink(link._id, { clientId, session });
          link = updated;
          action = 'G5_LINK_ROTATED';
        }
        smsMeta = await queueOnboardingIfPossible({
          clientId, estateId, tenant, link, token, merchant, session, actor,
        });
      });
    } finally {
      await session.endSession();
    }

    await audit({
      clientId, estateId, userId: actor?.userId, action, resource: 'MpesaSubmissionLink',
      resourceId: link._id,
      metadata: {
        tenantId: String(tenantId), version: link.linkVersion,
        smsQueued: smsMeta.queued, smsBlockedReason: smsMeta.reason,
      },
      ipAddress: actor?.ip, userAgent: actor?.userAgent,
    });
    return { link: view(link, merchant), token };
  },

  async revoke({ clientId, estateId, tenantId, actor }) {
    await assertTenant(clientId, estateId, tenantId);
    const session = await mongoose.startSession();
    let updated;
    try {
      await session.withTransaction(async () => {
        const link = await MpesaSubmissionLink.findOne({ clientId, estateId, tenantId }).session(session);
        if (!link) throw Errors.NotFound('Link not found');
        if (link.status === 'REVOKED') {
          updated = link;
          return;
        }
        updated = await MpesaSubmissionLink.findOneAndUpdate(
          { _id: link._id, clientId, estateId, tenantId, linkVersion: link.linkVersion, status: 'ACTIVE' },
          { $set: { status: 'REVOKED', tokenDigest: null, revokedAt: new Date() }, $inc: { linkVersion: 1 } },
          { new: true, session }
        );
        if (!updated) throw Errors.Conflict('Link changed concurrently; retry');
        await cancelQueuedForLink(link._id, { clientId, session });
      });
    } finally {
      await session.endSession();
    }
    await audit({
      clientId, estateId, userId: actor?.userId, action: 'G5_LINK_REVOKED', resource: 'MpesaSubmissionLink',
      resourceId: updated._id, metadata: { tenantId: String(tenantId) },
      ipAddress: actor?.ip, userAgent: actor?.userAgent,
    });
    return view(updated, null);
  },
};
