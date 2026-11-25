// Active merchant-profile <-> estate mappings. INACTIVE mappings never authorize.
// A mapping authorizes an estate to use a merchant channel; it is NOT receipt attribution.
import { MpesaMerchantProfile } from '../../models/MpesaMerchantProfile.js';
import { MpesaMerchantProfileEstate } from '../../models/MpesaMerchantProfileEstate.js';
import { MERCHANT_TYPE } from './daraja.constants.js';

export async function isActiveMapping({ merchantProfileId, clientId, estateId, session = null }) {
  if (!merchantProfileId || !clientId || !estateId) return false;
  const row = await MpesaMerchantProfileEstate.findOne({
    merchantProfileId, clientId, estateId, status: 'ACTIVE',
  }).session(session).select('_id').lean();
  return Boolean(row);
}

/** All ACTIVE Till profiles actively mapped to this estate (no arbitrary truncation). */
export async function listOperationalTillMerchants(clientId, estateId, { session = null } = {}) {
  const maps = await MpesaMerchantProfileEstate.find({ clientId, estateId, status: 'ACTIVE' })
    .session(session).select('merchantProfileId').lean();
  if (!maps.length) return [];
  return MpesaMerchantProfile.find({
    _id: { $in: maps.map((m) => m.merchantProfileId) },
    clientId,
    merchantType: MERCHANT_TYPE.BUY_GOODS_TILL,
    operationalState: 'ACTIVE',
  }).session(session);
}

/**
 * Resolve the Till a link/submission uses. With an explicit merchantProfileId that exact
 * profile must be an ACTIVE, actively-mapped Till. Without one, exactly one candidate is
 * required; several candidates mean an operator must choose (returns { ambiguous: true }).
 */
export async function resolveTillMerchant(clientId, estateId, { merchantProfileId = null, session = null } = {}) {
  const candidates = await listOperationalTillMerchants(clientId, estateId, { session });
  if (merchantProfileId) {
    const hit = candidates.find((p) => String(p._id) === String(merchantProfileId));
    return { merchant: hit || null, ambiguous: false };
  }
  if (candidates.length === 1) return { merchant: candidates[0], ambiguous: false };
  return { merchant: null, ambiguous: candidates.length > 1 };
}

/**
 * Registration-link eligibility is wider than receipt-posting eligibility.
 * A mapped Buy Goods Till in DRAFT/NOT_READY can receive an evidence-submission
 * link so a tenant can inspect/submit a receipt; matchSubmission keeps it UNMATCHED
 * until the profile becomes ACTIVE. SUSPENDED profiles never get new links.
 */
export async function resolveRegistrationTillMerchant(clientId, estateId, { merchantProfileId = null, session = null } = {}) {
  const maps = await MpesaMerchantProfileEstate.find({ clientId, estateId, status: 'ACTIVE' })
    .session(session).select('merchantProfileId').lean();
  if (!maps.length) return { merchant: null, ambiguous: false };
  const candidates = await MpesaMerchantProfile.find({
    _id: { $in: maps.map((mapping) => mapping.merchantProfileId) },
    clientId,
    merchantType: MERCHANT_TYPE.BUY_GOODS_TILL,
    operationalState: { $in: ['DRAFT', 'NOT_READY', 'ACTIVE'] },
  }).session(session);
  if (merchantProfileId) {
    const hit = candidates.find((profile) => String(profile._id) === String(merchantProfileId));
    return { merchant: hit || null, ambiguous: false };
  }
  if (candidates.length === 1) return { merchant: candidates[0], ambiguous: false };
  return { merchant: null, ambiguous: candidates.length > 1 };
}
