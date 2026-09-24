import { Router } from 'express';
import { z } from 'zod';
import { paymentController } from '../controllers/payment.controller.js';
import { authenticate } from '../middlewares/authenticate.js';
import { authorize } from '../middlewares/authorize.js';
import { clientContext } from '../middlewares/clientContext.js';
import { validate } from '../middlewares/validate.js';

const router = Router();

const manualPaymentSchema = z.object({
  houseId: z.string().min(1),
  amountCents: z.coerce.number().int().positive(),
  paymentDate: z.string().optional(),
  paymentReference: z.string().max(120).optional(),
  period: z.string().regex(/^\d{4}-\d{2}$/).optional(),
  tenantId: z.string().min(1).optional(),
});

router.get('/', authenticate, clientContext, paymentController.list);
router.post(
  '/',
  authenticate,
  clientContext,
  authorize('CLIENT_OWNER', 'CLIENT_ADMIN'),
  validate(manualPaymentSchema),
  paymentController.create
);

export default router;
