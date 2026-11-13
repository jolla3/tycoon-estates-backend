// src/services/mpesa/mpesaSubmissionLink.service.js — Tenant submission link lifecycle.
// One link per {clientId, estateId, tenantId}. Raw token is returned exactly once
// (create/rotate) and is never stored. Rotation/revocation use linkVersion CAS.
import { MpesaSubmissionLink } from '../../models/MpesaSubmissionLink.js';
import { MpesaMerchantProfile } from '../../models/MpesaMerchantProfile.js';
import { Tenant } from '../../models/Tenant.js';
import { audit } from '../audit.service.js';
import { cancelQueuedForLink } from '../g5ProtectedSms.service.js';
import { generateBearerToken, digestToken } from '../../utils/g5Token.js';
import { Errors } from '../../utils/errors.js';

/** Exactly one ACTIVE Till mapped to this Estate, else the link is not operational. */
export async function resolveOperationalMerchant(clientId, estateId) {
  const profiles = await MpesaMerchantProfile.find({ clientId, estateId, operationalState: 'ACTIVE' }).limit(2);
  return profiles.length === 1 ? profiles[0] : null;
}

function view(link, merchant) {
  return {
    id: link._id, tenantId: link.tenantId, estateId: link.estateId, status: link.status,
    version: link.linkVersion, rotatedAt: link.rotatedAt, revokedAt: link.revokedAt,
    operational: link.status === 'ACTIVE' && Boolean(merchant),
    // never: tokenDigest, raw token
  };
}

async function assertTenant(clientId, estateId, tenantId) {
  const t = await Tenant.findOne({ _id: tenantId, clientId, estateId }).select('_id');
  if (!t) throw Errors.TenantNotFound();
}

export const mpesaSubmissionLinkService = {
  async inspect({ clientId, estateId, tenantId }) {
    await assertTenant(clientId, estateId, tenantId);
    const link = await MpesaSubmissionLink.findOne({ clientId, estateId, tenantId });
    if (!link) return null;
    return view(link, await resolveOperationalMerchant(clientId, estateId));
  },

  /** Create, or rotate an existing link (also re-activates a revoked one). Returns the raw token once. */
  async issue({ clientId, estateId, tenantId, actor }) {
    await assertTenant(clientId, estateId, tenantId);
    const merchant = await resolveOperationalMerchant(clientId, estateId);
    const token = generateBearerToken();
    const tokenDigest = digestToken(token);
    let link = await MpesaSubmissionLink.findOne({ clientId, estateId, tenantId });
    let action = 'G5_LINK_ROTATED';
    if (!link) {
      try {
        link = await MpesaSubmissionLink.create({
          clientId, estateId, tenantId, merchantProfileId: merchant?._id || null,
          tokenDigest, createdByUserId: actor?.userId || null,
        });
        action = 'G5_LINK_CREATED';
      } catch (err) {
        if (err?.code === 11000) throw Errors.Conflict('Link was created concurrently; retry');
        throw err;
      }
    } else {
      const updated = await MpesaSubmissionLink.findOneAndUpdate(
        { _id: link._id, clientId, estateId, tenantId, linkVersion: link.linkVersion },
        { $set: { tokenDigest, status: 'ACTIVE', revokedAt: null, rotatedAt: new Date(),
          merchantProfileId: merchant?._id || null, lastRotatedByUserId: actor?.userId || null },
        $inc: { linkVersion: 1 } },
        { new: true }
      );
      if (!updated) throw Errors.Conflict('Link changed concurrently; retry');
      await cancelQueuedForLink(link._id, { clientId });
      link = updated;
    }
    await audit({ clientId, estateId, userId: actor?.userId, action, resource: 'MpesaSubmissionLink',
      resourceId: link._id, metadata: { tenantId: String(tenantId), version: link.linkVersion }, ipAddress: actor?.ip, userAgent: actor?.userAgent });
    return { link: view(link, merchant), token };
  },

  async revoke({ clientId, estateId, tenantId, actor }) {
    await assertTenant(clientId, estateId, tenantId);
    const link = await MpesaSubmissionLink.findOne({ clientId, estateId, tenantId });
    if (!link) throw Errors.NotFound('Link not found');
    if (link.status === 'REVOKED') return view(link, null);
    const updated = await MpesaSubmissionLink.findOneAndUpdate(
      { _id: link._id, clientId, estateId, tenantId, linkVersion: link.linkVersion, status: 'ACTIVE' },
      { $set: { status: 'REVOKED', tokenDigest: null, revokedAt: new Date() }, $inc: { linkVersion: 1 } },
      { new: true }
    );
    if (!updated) throw Errors.Conflict('Link changed concurrently; retry');
    await cancelQueuedForLink(link._id, { clientId });
    await audit({ clientId, estateId, userId: actor?.userId, action: 'G5_LINK_REVOKED', resource: 'MpesaSubmissionLink',
      resourceId: link._id, metadata: { tenantId: String(tenantId) }, ipAddress: actor?.ip, userAgent: actor?.userAgent });
    return view(updated, null);
  },
};
