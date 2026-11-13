import { mpesaSubmissionLinkService } from '../services/mpesa/mpesaSubmissionLink.service.js';
import { tenantAccountService, loadScopedTenant } from '../services/tenantAccount.service.js';
import { mpesaSubmissionReviewService } from '../services/mpesa/mpesaSubmissionReview.service.js';
import { apiResponse } from '../utils/apiResponse.js';

const actorOf = (req) => ({ userId: req.currentUser._id, ip: req.ip, userAgent: req.get('user-agent') });
const wrap = (fn) => async (req, res, next) => { try { await fn(req, res); } catch (e) { next(e); } };

async function scopedTenant(req) {
  const t = await loadScopedTenant(req.clientId, req.estateFilter, req.params.tenantId);
  return { clientId: req.clientId, estateId: t.estateId, tenantId: t._id, actor: actorOf(req) };
}

export const mpesaCollectionController = {
  inspectLink: wrap(async (req, res) => apiResponse.success(res, { link: await mpesaSubmissionLinkService.inspect(await scopedTenant(req)) })),
  issueLink: wrap(async (req, res) => {
    res.set('Cache-Control', 'no-store');
    return apiResponse.success(res, await mpesaSubmissionLinkService.issue(await scopedTenant(req)), 'Link issued; token is shown once', 201);
  }),
  revokeLink: wrap(async (req, res) => apiResponse.success(res, { link: await mpesaSubmissionLinkService.revoke(await scopedTenant(req)) })),
  account: wrap(async (req, res) => apiResponse.success(res, await tenantAccountService.view({ clientId: req.clientId, estateFilter: req.estateFilter, tenantId: req.params.tenantId }))),
  payments: wrap(async (req, res) => apiResponse.success(res, { payments: await tenantAccountService.payments({ clientId: req.clientId, estateFilter: req.estateFilter, tenantId: req.params.tenantId, limit: req.query.limit }) })),
  listSubmissions: wrap(async (req, res) => apiResponse.success(res, { submissions: await mpesaSubmissionReviewService.list({ clientId: req.clientId, estateFilter: req.estateFilter, state: req.query.state, limit: req.query.limit }) })),
  resolveSubmission: wrap(async (req, res) => apiResponse.success(res, await mpesaSubmissionReviewService.resolve({
    clientId: req.clientId, estateFilter: req.estateFilter, id: req.params.id,
    action: req.body?.action, reasonCode: req.body?.reasonCode, actor: actorOf(req),
  }))),
};
