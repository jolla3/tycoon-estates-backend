import { Router } from 'express';
import { z } from 'zod';
import { billingController } from '../controllers/billing.controller.js';
import { authenticate } from '../middlewares/authenticate.js';
import { authorize } from '../middlewares/authorize.js';
import { clientContext } from '../middlewares/clientContext.js';
import { validate } from '../middlewares/validate.js';

const router = Router();

const generateSchema = z.object({
  estateId: z.string().min(1).optional(),
  period: z.string().regex(/^\d{4}-\d{2}$/).optional(),
});

router.post(
  '/generate',
  authenticate,
  clientContext,
  authorize('CLIENT_OWNER', 'CLIENT_ADMIN'),
  validate(generateSchema),
  billingController.generate
);

router.get(
  '/houses/:houseId/account',
  authenticate,
  clientContext,
  billingController.houseAccount
);

export default router;
