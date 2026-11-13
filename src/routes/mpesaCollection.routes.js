// Authenticated G5 collection admin/account routes (CSRF boundary applies via apiRoutes mount).
import { Router } from 'express';
import { mpesaCollectionController as c } from '../controllers/mpesaCollection.controller.js';
import { authenticate } from '../middlewares/authenticate.js';
import { authorize } from '../middlewares/authorize.js';
import { clientContext } from '../middlewares/clientContext.js';

const router = Router();
const base = [authenticate, clientContext];
const admin = authorize('CLIENT_OWNER', 'CLIENT_ADMIN', 'SUPER_ADMIN');

router.get('/tenants/:tenantId/account', ...base, c.account);
router.get('/tenants/:tenantId/payments', ...base, c.payments);
router.get('/tenants/:tenantId/link', ...base, admin, c.inspectLink);
router.post('/tenants/:tenantId/link', ...base, admin, c.issueLink);
router.post('/tenants/:tenantId/link/revoke', ...base, admin, c.revokeLink);
router.get('/submissions', ...base, admin, c.listSubmissions);
router.post('/submissions/:id/resolve', ...base, admin, c.resolveSubmission);

export default router;
