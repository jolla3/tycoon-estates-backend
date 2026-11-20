// Tenant-facing view of PayBill collection references. Read-only DTOs plus one explicit issue action.
// Identity is ALWAYS the exact tenancy: every row is keyed by tenancyId; there is no "latest" or
// "current" default. Scoped by Client AND the caller's enforced estate set. A reference is a routing
// identifier, never a credential, but it is still only ever returned for the tenancy it belongs to.
import mongoose from 'mongoose';
import { MpesaCollectionReference } from '../../models/MpesaCollectionReference.js';
import { MpesaMerchantProfile } from '../../models/MpesaMerchantProfile.js';
import { MpesaMerchantProfileEstate } from '../../models/MpesaMerchantProfileEstate.js';
import { Tenancy } from '../../models/Tenancy.js';
import { House } from '../../models/House.js';
import { loadScopedTenant } from '../tenantAccount.service.js';
import { mpesaReferenceService } from './mpesaReference.service.js';
import { MERCHANT_TYPE } from './daraja.constants.js';
import { estateFilterClause } from '../../utils/estateFilter.js';
import { formatCollectionReference } from '../../utils/mpesaCollectionReference.js';
import { Errors } from '../../utils/errors.js';

const RETIRED_SHOWN = 5;
const oid = (v) => new mongoose.Types.ObjectId(String(v));

const refView = (r) => ({
  id: String(r._id), reference: r.reference, display: formatCollectionReference(r.reference),
  issuedAt: r.createdAt || null,
  ...(r.status === 'RETIRED' ? { retiredAt: r.retiredAt || null, retiredReason: r.retiredReason || null } : {}),
});

export const mpesaTenantReferenceService = {
  async view({ clientId, estateFilter, tenantId, page = 1, limit = 10 }) {
    const tenant = await loadScopedTenant(clientId, estateFilter, tenantId);
    const pageSize = Math.min(Math.max(Number(limit) || 10, 1), 20);
    const pageNo = Math.max(Number(page) || 1, 1);
    const filter = { clientId, tenantId: tenant._id, status: { $in: ['ACTIVE', 'CLOSED'] }, ...estateFilterClause(estateFilter) };
    const [tenancies, total] = await Promise.all([
      Tenancy.find(filter).sort({ startAt: -1, _id: -1 }).skip((pageNo - 1) * pageSize).limit(pageSize).lean(),
      Tenancy.countDocuments(filter),
    ]);
    const base = { tenantId: String(tenant._id), tenancies: [], page: pageNo, limit: pageSize, total, hasMore: pageNo * pageSize < total };
    if (!tenancies.length) return base;

    const tenancyIds = tenancies.map((t) => t._id);
    const estateIds = [...new Set(tenancies.map((t) => String(t.estateId)))];
    const mappings = await MpesaMerchantProfileEstate.find({ clientId, estateId: { $in: estateIds }, status: 'ACTIVE' }).select('merchantProfileId estateId').lean();
    const profileIds = [...new Set(mappings.map((m) => String(m.merchantProfileId)))];
    const [profiles, houses, activeRefs, retired] = await Promise.all([
      profileIds.length
        ? MpesaMerchantProfile.find({ clientId, _id: { $in: profileIds }, merchantType: MERCHANT_TYPE.PAYBILL }).select('displayName businessShortCode').lean()
        : [],
      House.find({ clientId, _id: { $in: tenancies.map((t) => t.houseId) } }).select('houseNumber').lean(),
      MpesaCollectionReference.find({ clientId, tenantId: tenant._id, tenancyId: { $in: tenancyIds }, status: 'ACTIVE' }).lean(),
      MpesaCollectionReference.aggregate([
        { $match: { clientId: oid(clientId), tenantId: tenant._id, tenancyId: { $in: tenancyIds }, status: 'RETIRED' } },
        { $sort: { retiredAt: -1, _id: -1 } },
        { $group: { _id: { t: '$tenancyId', m: '$merchantProfileId' }, count: { $sum: 1 }, recent: { $push: { _id: '$_id', reference: '$reference', createdAt: '$createdAt', retiredAt: '$retiredAt', retiredReason: '$retiredReason', status: '$status' } } } },
        { $project: { count: 1, recent: { $slice: ['$recent', RETIRED_SHOWN] } } },
      ]),
    ]);
    const profileById = new Map(profiles.map((p) => [String(p._id), p]));
    const houseById = new Map(houses.map((h) => [String(h._id), h.houseNumber]));
    const active = new Map(activeRefs.map((r) => [`${r.tenancyId}:${r.merchantProfileId}`, r]));
    const retiredBy = new Map(retired.map((g) => [`${g._id.t}:${g._id.m}`, g]));

    base.tenancies = tenancies.map((t) => {
      const merchants = mappings
        .filter((m) => String(m.estateId) === String(t.estateId) && profileById.has(String(m.merchantProfileId)))
        .map((m) => {
          const p = profileById.get(String(m.merchantProfileId));
          const key = `${t._id}:${m.merchantProfileId}`;
          const a = active.get(key);
          const g = retiredBy.get(key);
          return {
            merchantProfileId: String(p._id), displayName: p.displayName || null, businessShortCode: p.businessShortCode,
            active: a ? refView(a) : null,
            retired: (g?.recent || []).map(refView), retiredCount: g?.count || 0,
            canIssue: t.status === 'ACTIVE' && !a,
          };
        });
      return {
        tenancyId: String(t._id), estateId: String(t.estateId), houseId: String(t.houseId),
        houseNumber: houseById.get(String(t.houseId)) || null,
        status: t.status, startAt: t.startAt, endAt: t.endAt || null, merchants,
      };
    });
    return base;
  },

  /** Issue (or return) the reference for ONE explicitly chosen tenancy of this tenant. */
  async issue({ clientId, estateFilter, tenantId, tenancyId, merchantProfileId, actor, reqMeta }) {
    const tenant = await loadScopedTenant(clientId, estateFilter, tenantId);
    const tenancy = await Tenancy.findOne({ _id: tenancyId, clientId, tenantId: tenant._id, ...estateFilterClause(estateFilter) }).lean();
    if (!tenancy) throw Errors.NotFound('Tenancy not found for this tenant');
    const { reference, created } = await mpesaReferenceService.issue({ clientId, merchantProfileId, tenancyId: tenancy._id, actor, reqMeta });
    if (String(reference.tenantId) !== String(tenant._id) || String(reference.tenancyId) !== String(tenancy._id)) {
      throw Errors.Conflict('Reference identity mismatch'); // defence in depth; never disclose another tenancy's reference
    }
    return { created, reference: refView(reference), tenancyId: String(tenancy._id), merchantProfileId: String(merchantProfileId) };
  },
};
