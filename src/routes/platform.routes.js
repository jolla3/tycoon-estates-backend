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

const objectId = (label) => z.string().regex(/^[a-f\d]{24}$/i, `Invalid ${label}`);

export const createMpesaProfileSchema = z.object({
  merchantType: z.enum(['PAYBILL', 'BUY_GOODS_TILL']).default('BUY_GOODS_TILL'),
  displayName: z.string().trim().min(1).max(120).optional(),
  businessShortCode: z.string().trim().regex(/^\d{1,20}$/, 'Business shortcode must contain digits only'),
  // One merchant may serve several estates of the SAME client. Legacy single estateId still accepted.
  estateIds: z.array(objectId('estate id')).min(1).max(100).optional(),
  estateId: objectId('estate id').optional(),
}).strict().refine((v) => v.estateIds?.length || v.estateId, { message: 'Select at least one estate' });

export const estateMappingSchema = z.object({ estateId: objectId('estate id') }).strict();
export const pullNumberSchema = z.object({ msisdn: z.string().trim().min(9).max(16) }).strict();
export const issueReferenceSchema = z.object({ tenancyId: objectId('tenancy id') }).strict();
// Lifecycle: expectedRevision is mandatory (stale-update protection). No state is accepted from the caller.
const revisionField = z.number().int().min(0);
export const lifecycleActivateSchema = z.object({ expectedRevision: revisionField, reason: z.string().trim().max(500).optional() }).strict();
export const lifecycleSuspendSchema = z.object({ expectedRevision: revisionField, reason: z.string().trim().min(3).max(500) }).strict();
export const lifecycleResumeSchema = z.object({ expectedRevision: revisionField, reason: z.string().trim().max(500).optional() }).strict();
export const reconcileSchema = z.object({ outcome: z.enum(['NOT_REGISTERED', 'REGISTERED']) }).strict();

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

router.get('/mpesa/callback-config', platformController.mpesaCallbackConfig);
router.get('/clients/:clientId/mpesa-profiles/:profileId', platformController.getMpesaProfile);
router.post('/clients/:clientId/mpesa-profiles/:profileId/estates', validate(estateMappingSchema), platformController.mapMpesaEstate);
router.delete('/clients/:clientId/mpesa-profiles/:profileId/estates/:estateId', platformController.unmapMpesaEstate);
router.put('/clients/:clientId/mpesa-profiles/:profileId/pull-number', validate(pullNumberSchema), platformController.setMpesaPullNumber);
router.post('/clients/:clientId/mpesa-profiles/:profileId/registrations/c2b', platformController.registerMpesaC2b);
router.post('/clients/:clientId/mpesa-profiles/:profileId/registrations/pull', platformController.registerMpesaPull);
router.post('/clients/:clientId/mpesa-profiles/:profileId/registrations/:kind/reconcile', validate(reconcileSchema), platformController.reconcileMpesaRegistration);

router.post('/clients/:clientId/mpesa-profiles/:profileId/lifecycle/activate', validate(lifecycleActivateSchema), platformController.activateMpesaProfile);
router.post('/clients/:clientId/mpesa-profiles/:profileId/lifecycle/suspend', validate(lifecycleSuspendSchema), platformController.suspendMpesaProfile);
router.post('/clients/:clientId/mpesa-profiles/:profileId/lifecycle/resume', validate(lifecycleResumeSchema), platformController.resumeMpesaProfile);

router.get('/clients/:clientId/mpesa-profiles/:profileId/references', platformController.listMpesaReferences);
router.post('/clients/:clientId/mpesa-profiles/:profileId/references', validate(issueReferenceSchema), platformController.issueMpesaReference);
router.delete('/clients/:clientId/mpesa-profiles/:profileId/references/:referenceId', platformController.retireMpesaReference);

router.get('/integrations/banking', platformController.bankingIntegrations);
router.get('/integrations/mpesa', platformController.mpesaIntegrations);

router.get('/users', platformController.listUsers);
router.get('/audit', platformController.listAudit);
router.get('/subscriptions', platformController.listSubscriptions);

export default router;
