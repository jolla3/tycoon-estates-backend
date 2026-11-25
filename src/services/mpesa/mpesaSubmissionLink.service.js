// Tenant-level G5 submission link lifecycle.
// Identity is {clientId, estateId, tenantId}; a link is reusable across the
// Tenant's houses in the estate. Normal issue/resend never invalidates it.
import mongoose from 'mongoose';
import { MpesaSubmissionLink } from '../../models/MpesaSubmissionLink.js';
import { AuditLog } from '../../models/AuditLog.js';
import { SmsMessage } from '../../models/SmsMessage.js';
import { Tenant } from '../../models/Tenant.js';
import { Tenancy } from '../../models/Tenancy.js';
import { Estate } from '../../models/Estate.js';
import { resolveTillMerchant, resolveRegistrationTillMerchant } from './mpesaMerchantMapping.service.js';
import { checkEntitlement } from '../entitlement.service.js';
import { audit } from '../audit.service.js';
import {
  cancelQueuedForLink, queueProtectedSms, G5_ONBOARDING_TYPE,
  G5_ONBOARDING_VERSION, buildProtectedSmsAad,
} from '../g5ProtectedSms.service.js';
import { openEnvelope } from '../../utils/g5Envelope.js';
import { sealLinkToken, openLinkToken } from '../../utils/g5LinkTokenEnvelope.js';
import { generateBearerToken, digestToken, digestsEqual, isWellFormedToken } from '../../utils/g5Token.js';
import { Errors } from '../../utils/errors.js';
import { env } from '../../config/environment.js';
import { logger } from '../../config/logger.js';
import { formatSmsDisplayLabel } from '../smsTemplates.js';

export async function resolveOperationalMerchant(clientId, estateId, { merchantProfileId = null, session = null } = {}) {
  const { merchant } = await resolveTillMerchant(clientId, estateId, { merchantProfileId, session });
  return merchant;
}

function tokenContext(link) {
  return {
    linkId: link._id,
    clientId: link.clientId,
    estateId: link.estateId,
    tenantId: link.tenantId,
    linkVersion: link.linkVersion,
  };
}

function view(link, merchant) {
  return {
    id: link._id, tenantId: link.tenantId, estateId: link.estateId,
    status: link.status, version: link.linkVersion, rotatedAt: link.rotatedAt,
    revokedAt: link.revokedAt,
    operational: link.status === 'ACTIVE' && Boolean(merchant),
  };
}

async function assertTenant(clientId, estateId, tenantId, session = null) {
  // Tenant.estateId is a mutable compatibility pointer. Estate membership is
  // established by assertActiveEstateTenancy, not by this pointer.
  const query = Tenant.findOne({ _id: tenantId, clientId }).select('_id name phone');
  if (session) query.session(session);
  const tenant = await query;
  if (!tenant) throw Errors.TenantNotFound();
  return tenant;
}

async function assertActiveEstateTenancy(clientId, estateId, tenantId, session = null) {
  const query = Tenancy.findOne({ clientId, estateId, tenantId, status: 'ACTIVE' }).select('_id');
  if (session) query.session(session);
  const tenancy = await query;
  if (!tenancy) throw Errors.Conflict('Tenant has no active tenancy in this estate');
  return tenancy;
}

function buildOnboardingBody({ estateName, tillCode, token, registrationText = null }) {
  if (!estateName) throw Errors.Conflict('Estate identity is unavailable; onboarding SMS was not queued');
  const url = `${env.G5_PUBLIC_PAYMENT_URL}/pay#t=${token}`;
  const details = registrationText || 'Your M-PESA payment submission link is ready.';
  const displayEstateName = formatSmsDisplayLabel(estateName);
  return `${displayEstateName}: ${details} M-PESA Buy Goods Till ${tillCode}. Submit your M-PESA confirmation here: ${url}`;
}

async function queueOnboarding({ clientId, estateId, tenant, link, token, merchant, estateName, registrationText = null, session = null, messageId = null, attempt = 'delivery' }) {
  const phone = tenant?.phone && String(tenant.phone).trim();
  const tillCode = merchant?.businessShortCode ? String(merchant.businessShortCode) : null;
  if (!phone || !tillCode || !env.G5_PUBLIC_PAYMENT_URL || !estateName) {
    const reason = !phone ? 'tenant_phone_missing'
      : !tillCode ? 'merchant_till_unavailable'
        : !env.G5_PUBLIC_PAYMENT_URL ? 'public_payment_url_missing' : 'estate_name_missing';
    logger.info({ reason, linkId: String(link._id) }, 'G5 onboarding message not queued');
    return { queued: false, reason };
  }
  // Keep an inspectable outbox record even while SMS sending is disabled.
  // SUPPRESSED is durable: enabling dispatch later will not unexpectedly send an old test message.
  const dispatchMode = env.G5_PROTECTED_SMS_ENABLED === '1' ? 'ENABLED' : 'SUPPRESSED';
  const stableMessageId = messageId || new mongoose.Types.ObjectId();
  const r = await queueProtectedSms({
    clientId, estateId, tenantId: tenant._id,
    phone,
    body: buildOnboardingBody({ estateName, tillCode, token, registrationText }),
    type: G5_ONBOARDING_TYPE,
    notificationVersion: G5_ONBOARDING_VERSION,
    idempotencyKey: `onboard:${String(link._id)}:v${link.linkVersion}:${attempt}:${String(stableMessageId)}`,
    linkId: link._id,
    linkVersion: link.linkVersion,
    dispatchMode,
    session,
    messageId: stableMessageId,
  });
  return {
    queued: Boolean(r.id), created: r.created, reason: null, messageId: r.id,
    dispatchMode, dispatchSuppressed: dispatchMode === 'SUPPRESSED',
  };
}

async function recoverLegacyToken(link, { session = null } = {}) {
  // Digest-only links cannot be reversed. Recover only from a historical
  // protected onboarding payload whose AAD and HMAC both verify.
  const query = SmsMessage.find({
    clientId: link.clientId, estateId: link.estateId, tenantId: link.tenantId,
    g5LinkId: link._id, g5LinkVersion: link.linkVersion,
    deliveryMode: 'G5_PROTECTED', type: G5_ONBOARDING_TYPE,
    notificationVersion: G5_ONBOARDING_VERSION,
  }).select('+payloadEnvelope').sort({ createdAt: -1 }).limit(25);
  if (session) query.session(session);
  const messages = await query.lean();
  for (const row of messages) {
    try {
      const aad = buildProtectedSmsAad({
        messageId: row._id, clientId: row.clientId, estateId: row.estateId,
        tenantId: row.tenantId, linkId: row.g5LinkId, linkVersion: row.g5LinkVersion,
        type: row.type, notificationVersion: row.notificationVersion,
        idempotencyKey: row.idempotencyKey,
      });
      const payload = JSON.parse(openEnvelope(row.payloadEnvelope, aad));
      const urlMatch = String(payload.body || '').match(/https:\/\/[^\s]+/i);
      if (!urlMatch) continue;
      const url = new URL(urlMatch[0]);
      if (url.origin !== env.G5_PUBLIC_PAYMENT_URL || url.pathname !== '/pay' || url.search) continue;
      const tokenMatch = /^#t=([A-Za-z0-9_-]{43})$/.exec(url.hash);
      if (!tokenMatch || !isWellFormedToken(tokenMatch[1])) continue;
      if (!digestsEqual(digestToken(tokenMatch[1]), link.tokenDigest)) continue;
      return tokenMatch[1];
    } catch {
      // A malformed or unrelated historical row is ignored; never guess a token.
    }
  }
  const err = Errors.Conflict('legacy_link_token_unrecoverable_explicit_rotation_required');
  err.code = 'G5_LEGACY_LINK_TOKEN_UNRECOVERABLE';
  throw err;
}

async function loadToken(link, { session = null, persistLegacy = true } = {}) {
  if (link.tokenEnvelope) {
    const token = openLinkToken(link.tokenEnvelope, tokenContext(link));
    if (!digestsEqual(digestToken(token), link.tokenDigest)) {
      throw Errors.Conflict('Encrypted M-PESA link token does not match its verification digest');
    }
    return token;
  }
  if (!link.tokenDigest) throw Errors.Conflict('Active M-PESA link has no token digest');
  const token = await recoverLegacyToken(link, { session });
  if (persistLegacy) {
    link.tokenEnvelope = sealLinkToken(token, tokenContext(link));
    await link.save({ session: session || undefined });
  }
  return token;
}

async function requireEligibleMerchant(clientId, estateId, { merchantProfileId = null, session = null } = {}) {
  const eligibility = await checkEntitlement(clientId, 'MPESA', { session });
  if (!eligibility.entitled) throw Errors.InvalidRequest('Client is not entitled to M-PESA collection');
  const resolution = await resolveTillMerchant(clientId, estateId, { merchantProfileId, session });
  if (merchantProfileId && !resolution.merchant) {
    throw Errors.InvalidRequest('Selected merchant is not an active Till mapped to this estate');
  }
  if (resolution.ambiguous) throw Errors.Conflict('Several Tills are active for this estate; select a merchant profile');
  if (!resolution.merchant) throw Errors.Conflict('This estate has no active M-PESA Buy Goods Till mapping');
  return resolution.merchant;
}

export const mpesaSubmissionLinkService = {
  async inspect({ clientId, estateId, tenantId }) {
    await assertTenant(clientId, estateId, tenantId);
    const link = await MpesaSubmissionLink.findOne({ clientId, estateId, tenantId });
    if (!link) return null;
    return view(link, await resolveOperationalMerchant(clientId, estateId, { merchantProfileId: link.merchantProfileId }));
  },

  // Create once. An existing ACTIVE link is returned unchanged; it is never rotated here.
  async issue({ clientId, estateId, tenantId, actor, merchantProfileId = null }) {
    const session = await mongoose.startSession();
    const candidateToken = generateBearerToken();
    const candidateLinkId = new mongoose.Types.ObjectId();
    const candidateMessageId = new mongoose.Types.ObjectId();
    let result;
    try {
      await session.withTransaction(async () => {
        const tenant = await assertTenant(clientId, estateId, tenantId, session);
        await assertActiveEstateTenancy(clientId, estateId, tenantId, session);
        if (!tenant.phone) throw Errors.InvalidRequest('Tenant phone number is required before issuing an M-PESA SMS link');
        if (!env.G5_PUBLIC_PAYMENT_URL) throw Errors.ServiceUnavailable('G5_PUBLIC_PAYMENT_URL is not configured');
        let link = await MpesaSubmissionLink.findOne({ clientId, estateId, tenantId })
          .session(session).select('+tokenDigest +tokenEnvelope');
        const selectedMerchantProfileId = merchantProfileId || link?.merchantProfileId || null;
        const merchant = await requireEligibleMerchant(clientId, estateId, { merchantProfileId: selectedMerchantProfileId, session });
        const estate = await Estate.findOne({ _id: estateId, clientId }).session(session).select('name').lean();
        if (!estate?.name) throw Errors.Conflict('Estate identity could not be verified');
        let token;
        let created = false;
        if (!link) {
          const _id = candidateLinkId;
          const linkVersion = 1;
          const context = { linkId: _id, clientId, estateId, tenantId, linkVersion };
          token = candidateToken;
          const [doc] = await MpesaSubmissionLink.create([{
            _id, clientId, estateId, tenantId, merchantProfileId: merchant._id,
            tokenDigest: digestToken(token), tokenEnvelope: sealLinkToken(token, context),
            status: 'ACTIVE', linkVersion, createdByUserId: actor?.userId || null,
          }], { session });
          link = doc;
          created = true;
        } else if (link.status === 'ACTIVE') {
          token = await loadToken(link, { session });
        } else {
          throw Errors.Conflict('This M-PESA link was revoked; use the explicit security-rotation operation to reactivate it');
        }
        let smsMeta = { queued: false, reason: 'existing_link_reused' };
        if (created) {
          smsMeta = await queueOnboarding({
            clientId, estateId, tenant, link, token, merchant, estateName: estate.name,
            session, messageId: candidateMessageId, attempt: 'issue',
          });
          if (!smsMeta.queued) {
            throw Errors.ServiceUnavailable('New M-PESA link was not issued because its protected SMS could not be queued');
          }
        }
        result = { link: view(link, merchant), created, smsMeta };
      });
    } finally {
      await session.endSession();
    }
    if (result?.created) {
      await audit({ clientId, estateId, userId: actor?.userId, action: 'G5_LINK_CREATED', resource: 'MpesaSubmissionLink', resourceId: result.link.id, metadata: { tenantId: String(tenantId), version: result.link.version, smsQueued: result.smsMeta.queued, smsBlockedReason: result.smsMeta.reason }, ipAddress: actor?.ip, userAgent: actor?.userAgent });
    }
    return result;
  },

  // Explicit resend creates a distinct outbox attempt with the same token and linkVersion.
  async resend({ clientId, estateId, tenantId, actor }) {
    const session = await mongoose.startSession();
    const messageId = new mongoose.Types.ObjectId();
    let result;
    try {
      await session.withTransaction(async () => {
        const tenant = await assertTenant(clientId, estateId, tenantId, session);
        await assertActiveEstateTenancy(clientId, estateId, tenantId, session);
        if (!tenant.phone || !env.G5_PUBLIC_PAYMENT_URL) throw Errors.ServiceUnavailable('A tenant phone number and G5_PUBLIC_PAYMENT_URL are required for link resend');
        const link = await MpesaSubmissionLink.findOne({ clientId, estateId, tenantId, status: 'ACTIVE' })
          .session(session).select('+tokenDigest +tokenEnvelope');
        if (!link) throw Errors.NotFound('Active M-PESA submission link not found');
        const merchant = await requireEligibleMerchant(clientId, estateId, { merchantProfileId: link.merchantProfileId, session });
        const estate = await Estate.findOne({ _id: estateId, clientId }).session(session).select('name').lean();
        const token = await loadToken(link, { session });
        const resendKeyPrefix = 'g5:onboard:' + String(link._id) + ':v' + link.linkVersion + ':resend:';
        const recentAttempt = await SmsMessage.findOne({
          clientId, estateId, tenantId, g5LinkId: link._id,
          g5LinkVersion: link.linkVersion,
          deliveryMode: 'G5_PROTECTED', type: G5_ONBOARDING_TYPE,
          idempotencyKey: { $regex: '^' + resendKeyPrefix },
          createdAt: { $gte: new Date(Date.now() - 60_000) },
        }).session(session).select('_id');
        if (recentAttempt) {
          result = { link: view(link, merchant), queued: false, reason: 'resend_throttled' };
          return;
        }
        const smsMeta = await queueOnboarding({
          clientId, estateId, tenant, link, token, merchant, estateName: estate?.name,
          session, messageId, attempt: 'resend',
        });
        result = { link: view(link, merchant), queued: smsMeta.queued, reason: smsMeta.reason };
      });
    } finally {
      await session.endSession();
    }
    await audit({ clientId, estateId, userId: actor?.userId, action: 'G5_LINK_RESEND_REQUESTED', resource: 'MpesaSubmissionLink', resourceId: result.link.id, metadata: { tenantId: String(tenantId), version: result.link.version, queued: result.queued, reason: result.reason }, ipAddress: actor?.ip, userAgent: actor?.userAgent });
    return result;
  },

  // Explicit security rotation is separate from normal issue/resend.
  async rotate({ clientId, estateId, tenantId, actor, expectedLinkVersion }) {
    if (!Number.isSafeInteger(expectedLinkVersion) || expectedLinkVersion < 1) {
      throw Errors.InvalidRequest('expectedLinkVersion is required for security rotation');
    }
    const token = generateBearerToken();
    const messageId = new mongoose.Types.ObjectId();
    const session = await mongoose.startSession();
    let result;
    try {
      await session.withTransaction(async () => {
        const tenant = await assertTenant(clientId, estateId, tenantId, session);
        await assertActiveEstateTenancy(clientId, estateId, tenantId, session);
        if (!tenant.phone || !env.G5_PUBLIC_PAYMENT_URL) throw Errors.ServiceUnavailable('A tenant phone number and G5_PUBLIC_PAYMENT_URL are required for link rotation');
        const link = await MpesaSubmissionLink.findOne({ clientId, estateId, tenantId, status: { $in: ['ACTIVE', 'REVOKED'] }, linkVersion: expectedLinkVersion })
          .session(session).select('+tokenDigest +tokenEnvelope');
        if (!link) throw Errors.Conflict('M-PESA link changed; refresh before rotating');
        const merchant = await requireEligibleMerchant(clientId, estateId, { merchantProfileId: link.merchantProfileId, session });
        const estate = await Estate.findOne({ _id: estateId, clientId }).session(session).select('name').lean();
        const nextVersion = link.linkVersion + 1;
        link.tokenDigest = digestToken(token);
        link.tokenEnvelope = sealLinkToken(token, { linkId: link._id, clientId, estateId, tenantId, linkVersion: nextVersion });
        link.linkVersion = nextVersion;
        link.status = 'ACTIVE';
        link.revokedAt = null;
        link.rotatedAt = new Date();
        link.lastRotatedByUserId = actor?.userId || null;
        link.merchantProfileId = merchant._id;
        await link.save({ session });
        await cancelQueuedForLink(link._id, { clientId, session });
        const smsMeta = await queueOnboarding({ clientId, estateId, tenant, link, token, merchant, estateName: estate?.name, session, messageId, attempt: 'rotation' });
        if (!smsMeta.queued) {
          throw Errors.ServiceUnavailable('Security rotation was rolled back because the replacement link could not be delivered');
        }
        result = { link: view(link, merchant), smsMeta };
      });
    } finally {
      await session.endSession();
    }
    await audit({ clientId, estateId, userId: actor?.userId, action: 'G5_LINK_SECURITY_ROTATED', resource: 'MpesaSubmissionLink', resourceId: result.link.id, metadata: { tenantId: String(tenantId), version: result.link.version, smsQueued: result.smsMeta.queued, smsBlockedReason: result.smsMeta.reason }, ipAddress: actor?.ip, userAgent: actor?.userAgent });
    return result;
  },

  // Registration-owned provisioning: shares the tenant/tenancy transaction and never sends
  // to Celcom inline. Non-M-PESA estates are explicitly ineligible and use ordinary SMS.
  async provisionForRegistration({ clientId, estateId, tenant, house, estate, registrationText, session, linkId: candidateLinkId, messageId, token: candidateToken, actorUserId = null }) {
    if (!session) throw Errors.ServiceUnavailable('Registration M-PESA provisioning requires the caller transaction');
    await assertActiveEstateTenancy(clientId, estateId, tenant._id, session);
    const eligibility = await checkEntitlement(clientId, 'MPESA', { session });
    if (!eligibility.entitled) return { eligible: false, reason: 'mpesa_not_entitled' };
    // Eligibility/link creation is independent from SMS dispatch. With dispatch
    // disabled, queueOnboarding stores the exact message as SUPPRESSED for review.
    if (!tenant?.phone || !env.G5_PUBLIC_PAYMENT_URL || !estate?.name) {
      return {
        eligible: false,
        reason: !tenant?.phone ? 'tenant_phone_missing'
          : !env.G5_PUBLIC_PAYMENT_URL ? 'public_payment_url_missing' : 'estate_name_missing',
      };
    }
    const existing = await MpesaSubmissionLink.findOne({ clientId, estateId, tenantId: tenant._id })
      .session(session).select('+tokenDigest +tokenEnvelope');
    // An active reusable link retains its original operational Till binding.
    // Never send a newly mapped Till with an old link token.
    const merchantProfileId = existing?.status === 'ACTIVE' ? existing.merchantProfileId : null;
    const resolution = await resolveRegistrationTillMerchant(clientId, estateId, { merchantProfileId, session });
    if (!resolution.merchant || resolution.ambiguous) {
      return { eligible: false, reason: resolution.ambiguous ? 'estate_till_ambiguous' : 'estate_till_unavailable' };
    }
    if (existing?.status === 'ACTIVE') {
      // Reuse the original token when the Tenant returns to an estate; never rotate it.
      if (!existing.merchantProfileId) {
        existing.merchantProfileId = resolution.merchant._id;
        await existing.save({ session });
      }
      const token = await loadToken(existing, { session });
      const smsMeta = await queueOnboarding({
        clientId, estateId, tenant, link: existing, token, merchant: resolution.merchant,
        estateName: estate.name, registrationText, session, messageId: messageId || new mongoose.Types.ObjectId(), attempt: 'registration-reuse',
      });
      if (!smsMeta.queued) {
        const err = Errors.ServiceUnavailable('Eligible M-PESA notification could not be queued: ' + smsMeta.reason);
        err.code = 'G5_REGISTRATION_OUTBOX_FAILED';
        throw err;
      }
      return { eligible: true, existing: true, linkId: existing._id, queued: true, reason: null };
    }
    const linkId = existing?._id || candidateLinkId || new mongoose.Types.ObjectId();
    const version = existing ? existing.linkVersion + 1 : 1;
    const token = candidateToken || generateBearerToken();
    const link = existing || new MpesaSubmissionLink({ _id: linkId, clientId, estateId, tenantId: tenant._id });
    link.merchantProfileId = resolution.merchant._id;
    link.tokenDigest = digestToken(token);
    link.tokenEnvelope = sealLinkToken(token, { linkId, clientId, estateId, tenantId: tenant._id, linkVersion: version });
    link.linkVersion = version;
    link.status = 'ACTIVE';
    link.revokedAt = null;
    if (!existing) link.createdByUserId = actorUserId || null;
    else link.lastRotatedByUserId = actorUserId || null;
    await link.save({ session });
    const stableMessageId = messageId || new mongoose.Types.ObjectId();
    const smsMeta = await queueOnboarding({
      clientId, estateId, tenant, link, token, merchant: resolution.merchant,
      estateName: estate.name, registrationText, session, messageId: stableMessageId, attempt: 'registration',
    });
    if (!smsMeta.queued) {
      const err = Errors.ServiceUnavailable(`Eligible M-PESA registration SMS could not be queued: ${smsMeta.reason}`);
      err.code = 'G5_REGISTRATION_OUTBOX_FAILED';
      throw err;
    }
    return { eligible: true, existing: false, linkId: link._id, queued: true };
  },

  // Called from the tenancy-closing transaction. The tenant-level link survives
  // while another ACTIVE Tenancy remains in the same estate; final active exit
  // revokes it regardless of retained unpaid balances or carried credit.
  async revokeAfterEstateExit({ clientId, estateId, tenantId, session, actorUserId = null }) {
    if (!session) throw Errors.ServiceUnavailable('Link exit checks require the tenancy transaction');
    const active = await Tenancy.countDocuments({ clientId, estateId, tenantId, status: 'ACTIVE' }).session(session);
    if (active > 0) return { revoked: false, reason: 'active_tenancy_remains' };
    const link = await MpesaSubmissionLink.findOne({ clientId, estateId, tenantId, status: 'ACTIVE' })
      .session(session).select('+tokenDigest +tokenEnvelope');
    if (!link) return { revoked: false, reason: 'no_active_link' };
    link.status = 'REVOKED';
    link.tokenDigest = null;
    link.tokenEnvelope = null;
    link.revokedAt = new Date();
    link.linkVersion += 1;
    await link.save({ session });
    await cancelQueuedForLink(link._id, { clientId, session });
    await AuditLog.create([{
      clientId, estateId, userId: actorUserId || undefined,
      action: 'G5_LINK_REVOKED', resource: 'MpesaSubmissionLink', resourceId: link._id,
      description: 'Tenant M-PESA submission link revoked after final active tenancy exit from estate',
      metadata: { tenantId: String(tenantId), linkVersion: link.linkVersion, reason: 'TENANCY_EXIT' },
    }], { session });
    return { revoked: true, linkId: link._id, version: link.linkVersion, actorUserId };
  },

  async revoke({ clientId, estateId, tenantId, actor }) {
    await assertTenant(clientId, estateId, tenantId);
    const session = await mongoose.startSession();
    let updated;
    try {
      await session.withTransaction(async () => {
        const link = await MpesaSubmissionLink.findOne({ clientId, estateId, tenantId }).session(session)
          .select('+tokenDigest +tokenEnvelope');
        if (!link) throw Errors.NotFound('Link not found');
        if (link.status === 'REVOKED') { updated = link; return; }
        link.status = 'REVOKED';
        link.tokenDigest = null;
        link.tokenEnvelope = null;
        link.revokedAt = new Date();
        link.linkVersion += 1;
        updated = await link.save({ session });
        await cancelQueuedForLink(link._id, { clientId, session });
      });
    } finally {
      await session.endSession();
    }
    await audit({ clientId, estateId, userId: actor?.userId, action: 'G5_LINK_REVOKED', resource: 'MpesaSubmissionLink', resourceId: updated._id, metadata: { tenantId: String(tenantId) }, ipAddress: actor?.ip, userAgent: actor?.userAgent });
    return view(updated, null);
  },
};
