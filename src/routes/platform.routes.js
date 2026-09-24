// src/routes/platform.routes.js
// SUPER_ADMIN platform control plane under /api/v1/platform
import { Router } from 'express';
import { platformController } from '../controllers/platform.controller.js';
import { authenticate } from '../middlewares/authenticate.js';
import { authorize } from '../middlewares/authorize.js';
import { validate } from '../middlewares/validate.js';
import { z } from 'zod';

const router = Router();

// Every platform route requires an authenticated SUPER_ADMIN.
router.use(authenticate, authorize('SUPER_ADMIN'));

const provisionSchema = z.object({
  clientName: z.string().min(2).max(200),
  ownerName: z.string().min(2).max(200),
  email: z.string().email(),
  phone: z.string().min(7).max(30).optional(),
  password: z.string().min(8).max(128),
  plan: z.enum(['trial', 'basic', 'pro']).optional(),
});

const updateClientSchema = z.object({
  name: z.string().min(2).max(200).optional(),
});

router.get('/overview', platformController.overview);
router.get('/health', platformController.health);

router.get('/clients', platformController.listClients);
router.post('/clients', validate(provisionSchema), platformController.provisionClient);
router.get('/clients/:clientId', platformController.getClient);
router.patch('/clients/:clientId', validate(updateClientSchema), platformController.updateClient);
router.post('/clients/:clientId/activate', platformController.activateClient);
router.post('/clients/:clientId/deactivate', platformController.deactivateClient);

router.get('/users', platformController.listUsers);
router.get('/audit', platformController.listAudit);
router.get('/subscriptions', platformController.listSubscriptions);

export default router;
