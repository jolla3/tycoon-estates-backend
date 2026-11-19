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
  products: z.array(z.enum(['BANKING', 'MPESA'])).max(2).optional(),
  startDate: z.coerce.date().optional(),
  endDate: z.coerce.date().optional(),
}).strict();

const updateSubscriptionSchema = z.object({
  plan: z.enum(['trial', 'basic', 'pro']).optional(),
  products: z.array(z.enum(['BANKING', 'MPESA'])).max(2).optional(),
  startDate: z.coerce.date().optional(),
  endDate: z.coerce.date().nullable().optional(),
}).strict().refine((v) => Object.keys(v).length > 0, { message: 'No changes supplied' });

const updateClientSchema = z.object({
  name: z.string().min(2).max(200).optional(),
});

export const createMpesaProfileSchema = z.object({
  displayName: z.string().trim().min(1).max(120).optional(),
  businessShortCode: z.string().trim().regex(/^\\d{1,20}$/, 'Business shortcode must contain digits only'),
  // The current G5 posting model maps one Till profile to one estate.
  estateId: z.string().regex(/^[a-f\\d]{24}$/i, 'Invalid estate id'),
}).strict();

router.get('/overview', platformController.overview);
router.get('/health', platformController.health);

router.get('/clients', platformController.listClients);
router.post('/clients', validate(provisionSchema), platformController.provisionClient);
router.get('/clients/:clientId', platformController.getClient);
router.patch('/clients/:clientId', validate(updateClientSchema), platformController.updateClient);
router.patch('/clients/:clientId/subscription', validate(updateSubscriptionSchema), platformController.updateClientSubscription);
router.get('/entitlement-inventory', platformController.entitlementInventory);
router.post('/clients/:clientId/activate', platformController.activateClient);
router.post('/clients/:clientId/deactivate', platformController.deactivateClient);

router.get('/clients/:clientId/diagnostics', platformController.clientDiagnostics);
router.post('/clients/:clientId/mpesa-profiles', validate(createMpesaProfileSchema), platformController.createMpesaProfile);

router.get('/integrations/banking', platformController.bankingIntegrations);
router.get('/integrations/mpesa', platformController.mpesaIntegrations);

router.get('/users', platformController.listUsers);
router.get('/audit', platformController.listAudit);
router.get('/subscriptions', platformController.listSubscriptions);

export default router;
