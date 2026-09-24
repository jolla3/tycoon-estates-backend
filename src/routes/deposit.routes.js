import { Router } from 'express';
import { z } from 'zod';
import { depositController } from '../controllers/deposit.controller.js';
import { authenticate } from '../middlewares/authenticate.js';
import { authorize } from '../middlewares/authorize.js';
import { clientContext } from '../middlewares/clientContext.js';
import { validate } from '../middlewares/validate.js';

const router = Router({ mergeParams: true });

router.get('/:tenantId', authenticate, clientContext, depositController.get);
router.post(
  '/:tenantId/require',
  authenticate,
  clientContext,
  authorize('CLIENT_OWNER', 'CLIENT_ADMIN'),
  validate(z.object({ requiredCents: z.coerce.number().int().min(0), moveInDate: z.string().optional() })),
  depositController.require
);
router.post(
  '/:tenantId/pay',
  authenticate,
  clientContext,
  authorize('CLIENT_OWNER', 'CLIENT_ADMIN'),
  validate(z.object({ amountCents: z.coerce.number().int().min(1) })),
  depositController.pay
);
router.post(
  '/:tenantId/deduct',
  authenticate,
  clientContext,
  authorize('CLIENT_OWNER', 'CLIENT_ADMIN'),
  validate(
    z.object({
      amountCents: z.coerce.number().int().min(1),
      reason: z.string().min(1).max(500),
      notes: z.string().max(1000).optional(),
    })
  ),
  depositController.deduct
);
router.post(
  '/:tenantId/settle',
  authenticate,
  clientContext,
  authorize('CLIENT_OWNER', 'CLIENT_ADMIN'),
  depositController.settle
);

export default router;
