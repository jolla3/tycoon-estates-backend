import { mpesaSubmissionLinkService } from '../services/mpesa/mpesaSubmissionLink.service.js';
import { tenantAccountService } from '../services/tenantAccount.service.js';
import { Tenant } from '../models/Tenant.js';
import { Tenancy } from '../models/Tenancy.js';
import { MpesaSubmissionLink } from '../models/MpesaSubmissionLink.js';
import { Errors } from '../utils/errors.js';
import { mpesaSubmissionReviewService } from '../services/mpesa/mpesaSubmissionReview.service.js';
import { mpesaTenantReferenceService } from '../services/mpesa/mpesaTenantReference.service.js';
import { apiResponse } from '../utils/apiResponse.js';

const actorOf = (req) => ({ userId: req.currentUser._id, ip: req.ip, userAgent: req.get('user-agent') });
const wrap = (fn) => async (req, res, next) => { try { await fn(req, res); } catch (e) { next(e); } };

async function scopedTenant(req) {
  const tenant = await Tenant.findOne({ _id: req.params.tenantId, clientId: req.clientId })
    .select('_id estateId').lean();
  if (!tenant) throw Errors.TenantNotFound();

  // Tenant.estateId is a mutable compatibility pointer. When a tenant has
  // active tenancies in more than one estate, callers may select the target
  // estate explicitly; otherwise retain the existing pointer-based default.
  const estateId = req.query.estateId || tenant.estateId;
  if (!/^[a-f\d]{24}$/i.test(String(estateId || ''))) {
    throw Errors.InvalidRequest('A valid estateId is required for this tenant link operation');
  }

  const permitted = Array.isArray(req.estateFilter)
    ? req.estateFilter.map(String)
    : req.estateFilter ? [String(req.estateFilter)] : null;
  if (permitted && !permitted.includes(String(estateId))) {
    throw Errors.Forbidden('You do not have access to this estate');
  }

  const [activeTenancy, existingLink] = await Promise.all([
    Tenancy.findOne({ clientId: req.clientId, estateId, tenantId: tenant._id, status: 'ACTIVE' })
      .select('_id').lean(),
    MpesaSubmissionLink.findOne({ clientId: req.clientId, estateId, tenantId: tenant._id })
      .select('_id').lean(),
  ]);
  if (!activeTenancy && !existingLink) throw Errors.TenantNotFound();

  return { clientId: req.clientId, estateId, tenantId: tenant._id, actor: actorOf(req) };
}

export const mpesaCollectionController = {
  inspectLink: wrap(async (req, res) => apiResponse.success(res, { link: await mpesaSubmissionLinkService.inspect(await scopedTenant(req)) })),
  issueLink: wrap(async (req, res) => {
    res.set('Cache-Control', 'no-store');
    const result = await mpesaSubmissionLinkService.issue(await scopedTenant(req));
    return apiResponse.success(res, result, result.created ? 'Payment link created' : 'Existing payment link reused', result.created ? 201 : 200);
  }),
  resendLink: wrap(async (req, res) => {
    res.set('Cache-Control', 'no-store');
    return apiResponse.success(res, await mpesaSubmissionLinkService.resend(await scopedTenant(req)), 'Existing payment link delivery queued');
  }),
  rotateLink: wrap(async (req, res) => {
    res.set('Cache-Control', 'no-store');
    return apiResponse.success(res, await mpesaSubmissionLinkService.rotate({ ...(await scopedTenant(req)), expectedLinkVersion: req.body.expectedLinkVersion }), 'Payment link security rotation completed');
  }),
  revokeLink: wrap(async (req, res) => apiResponse.success(res, { link: await mpesaSubmissionLinkService.revoke(await scopedTenant(req)) })),
  references: wrap(async (req, res) => {
    res.set('Cache-Control', 'no-store');
    return apiResponse.success(res, await mpesaTenantReferenceService.view({
      clientId: req.clientId, estateFilter: req.estateFilter, tenantId: req.params.tenantId, page: req.query.page, limit: req.query.limit,
    }));
  }),
  issueReference: wrap(async (req, res) => {
    const out = await mpesaTenantReferenceService.issue({
      clientId: req.clientId, estateFilter: req.estateFilter, tenantId: req.params.tenantId,
      tenancyId: req.body.tenancyId, merchantProfileId: req.body.merchantProfileId,
      actor: { _id: req.currentUser._id }, reqMeta: { ip: req.ip, userAgent: req.get('user-agent') },
    });
    return apiResponse.success(res, out, out.created ? 'Reference issued' : 'Reference already issued', out.created ? 201 : 200);
  }),
  account: wrap(async (req, res) => apiResponse.success(res, await tenantAccountService.view({ clientId: req.clientId, estateFilter: req.estateFilter, tenantId: req.params.tenantId }))),
  payments: wrap(async (req, res) => apiResponse.success(res, { payments: await tenantAccountService.payments({ clientId: req.clientId, estateFilter: req.estateFilter, tenantId: req.params.tenantId, limit: req.query.limit }) })),
  listSubmissions: wrap(async (req, res) => apiResponse.success(res, { submissions: await mpesaSubmissionReviewService.list({ clientId: req.clientId, estateFilter: req.estateFilter, state: req.query.state, limit: req.query.limit }) })),
  resolveSubmission: wrap(async (req, res) => apiResponse.success(res, await mpesaSubmissionReviewService.resolve({
    clientId: req.clientId, estateFilter: req.estateFilter, id: req.params.id,
    action: req.body?.action, reasonCode: req.body?.reasonCode, actor: actorOf(req),
  }))),
};
