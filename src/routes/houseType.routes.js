import { Router } from 'express';
import { z } from 'zod';
import { houseTypeController } from '../controllers/houseType.controller.js';
import { authenticate } from '../middlewares/authenticate.js';
import { authorize } from '../middlewares/authorize.js';
import { clientContext } from '../middlewares/clientContext.js';
import { validate } from '../middlewares/validate.js';

const router = Router();

const billingLine = z.object({
  chargeType: z.enum(['RENT', 'WATER', 'ELECTRICITY', 'OTHER']),
  description: z.string().max(200).optional(),
  amountCents: z.coerce.number().int().min(0),
  dueDay: z.coerce.number().int().min(1).max(31).optional(),
});

const createSchema = z.object({
  name: z.string().min(1).max(80),
  description: z.string().max(500).optional(),
  defaultRentCents: z.coerce.number().int().min(0).optional(),
  defaultDueDay: z.coerce.number().int().min(1).max(31).optional(),
  defaultBilling: z.array(billingLine).optional(),
  isActive: z.boolean().optional(),
});

const updateSchema = createSchema.partial();

router.get('/', authenticate, clientContext, houseTypeController.list);
router.get('/:id/workspace', authenticate, clientContext, houseTypeController.workspace);
router.get('/:id', authenticate, clientContext, houseTypeController.get);
router.post(
  '/',
  authenticate,
  clientContext,
  authorize('CLIENT_OWNER', 'CLIENT_ADMIN'),
  validate(createSchema),
  houseTypeController.create
);
router.patch(
  '/:id',
  authenticate,
  clientContext,
  authorize('CLIENT_OWNER', 'CLIENT_ADMIN'),
  validate(updateSchema),
  houseTypeController.update
);
router.post(
  '/:id/deactivate',
  authenticate,
  clientContext,
  authorize('CLIENT_OWNER', 'CLIENT_ADMIN'),
  houseTypeController.deactivate
);

export default router;
