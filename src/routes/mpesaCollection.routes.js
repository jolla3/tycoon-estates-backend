// Authenticated G5 collection admin/account routes (CSRF boundary applies via apiRoutes mount).
import { Router } from 'express';
import { mpesaCollectionController as c } from '../controllers/mpesaCollection.controller.js';
import { authenticate } from '../middlewares/authenticate.js';
import { authorize } from '../middlewares/authorize.js';
import { clientContext } from '../middlewares/clientContext.js';
import { requireProduct } from '../middlewares/requireProduct.js';
import { validate } from '../middlewares/validate.js';
import { z } from 'zod';

const router = Router();
const objectId = z.string().regex(/^[a-f\d]{24}$/i, 'Invalid id');
export const issueTenantReferenceSchema = z.object({ tenancyId: objectId, merchantProfileId: objectId }).strict();
export const referencesQuerySchema = z.object({ page: z.coerce.number().int().min(1).optional(), limit: z.coerce.number().int().min(1).max(20).optional() }).strict();
const base = [authenticate, clientContext, requireProduct('MPESA')];
const admin = authorize('CLIENT_OWNER', 'CLIENT_ADMIN', 'SUPER_ADMIN');

router.get('/tenants/:tenantId/account', ...base, c.account);
router.get('/tenants/:tenantId/payments', ...base, c.payments);
router.get('/tenants/:tenantId/references', ...base, validate(referencesQuerySchema, 'query'), c.references);
router.post('/tenants/:tenantId/references', ...base, admin, validate(issueTenantReferenceSchema), c.issueReference);
router.get('/tenants/:tenantId/link', ...base, admin, c.inspectLink);
router.post('/tenants/:tenantId/link', ...base, admin, c.issueLink);
router.post('/tenants/:tenantId/link/resend', ...base, admin, c.resendLink);
router.post('/tenants/:tenantId/link/rotate', ...base, admin, validate(z.object({ expectedLinkVersion: z.number().int().min(1) }).strict()), c.rotateLink);
router.post('/tenants/:tenantId/link/revoke', ...base, admin, c.revokeLink);
router.get('/submissions', ...base, admin, c.listSubmissions);
router.get('/submissions/:id/evidence', ...base, admin, validate(z.object({ id: objectId }).strict(), 'params'), c.submissionEvidence);
router.post('/submissions/:id/resolve', ...base, admin, validate(z.object({ id: objectId }).strict(), 'params'), c.resolveSubmission);

export default router;
