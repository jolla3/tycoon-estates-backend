// src/routes/house.routes.js
import { Router } from 'express';
import { houseController } from '../controllers/house.controller.js';
import { authenticate } from '../middlewares/authenticate.js';
import { authorize } from '../middlewares/authorize.js';
import { clientContext } from '../middlewares/clientContext.js';
import { validate } from '../middlewares/validate.js';
import { schemas } from '../utils/validators.js';
import { z } from 'zod';

const router = Router();

const billingConfigSchema = z.object({
  chargeType: z.enum(['RENT', 'WATER', 'ELECTRICITY', 'OTHER']),
  description: z.string().max(200).optional(),
  amountCents: z.coerce.number().int().min(0, 'amountCents must be a non-negative integer (cents)'),
  dueDay: z.preprocess(
    (v) => (v === '' || v === null || v === undefined ? undefined : v),
    z.coerce.number().int().min(1).max(31).optional()
  ),
  isActive: z.boolean().optional(),
  effectiveFrom: z.preprocess(
    (v) => (v === '' || v === null ? undefined : v),
    z.string().optional()
  ),
});

router.get('/', authenticate, clientContext, houseController.list);
router.get('/:id', authenticate, clientContext, houseController.get);
router.post(
  '/',
  authenticate,
  clientContext,
  authorize('CLIENT_OWNER', 'CLIENT_ADMIN'),
  validate(schemas.createHouse),
  houseController.create
);
router.patch(
  '/:id',
  authenticate,
  clientContext,
  authorize('CLIENT_OWNER', 'CLIENT_ADMIN'),
  validate(schemas.updateHouse),
  houseController.update
);

router.get('/:id/billing-config', authenticate, clientContext, houseController.listBillingConfig);
router.put(
  '/:id/billing-config',
  authenticate,
  clientContext,
  authorize('CLIENT_OWNER', 'CLIENT_ADMIN'),
  validate(billingConfigSchema),
  houseController.upsertBillingConfig
);
router.post(
  '/:id/billing-config/:chargeType/deactivate',
  authenticate,
  clientContext,
  authorize('CLIENT_OWNER', 'CLIENT_ADMIN'),
  houseController.deactivateBillingConfig
);

export default router;
