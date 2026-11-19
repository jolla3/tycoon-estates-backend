import { Router } from 'express';
import { z } from 'zod';
import { paymentController } from '../controllers/payment.controller.js';
import { authenticate } from '../middlewares/authenticate.js';
import { authorize } from '../middlewares/authorize.js';
import { clientContext } from '../middlewares/clientContext.js';
import { validate } from '../middlewares/validate.js';

const router = Router();

const objectId = z.string().regex(/^[a-f\d]{24}$/i, 'Invalid id');
const periodString = z.string().regex(/^\d{4}-(0[1-9]|1[0-2])$/);

export const manualPaymentSchema = z.object({
  houseId: objectId,
  amountCents: z.coerce.number().int().positive(),
  paymentDate: z.string().optional(),
  paymentReference: z.string().max(120).optional(),
  period: periodString.optional(),
  tenantId: objectId.optional(),
  tenancyId: objectId.optional(),
});

export const manualOptionsQuerySchema = z.object({
  houseId: objectId,
  period: periodString.optional(),
  page: z.coerce.number().int().min(1).max(10000).optional(),
  limit: z.coerce.number().int().min(1).max(50).optional(),
  search: z.string().trim().max(80).optional(),
}).strict();

router.get('/', authenticate, clientContext, paymentController.list);
router.get(
  '/manual-options',
  authenticate,
  clientContext,
  authorize('CLIENT_OWNER', 'CLIENT_ADMIN'),
  validate(manualOptionsQuerySchema, 'query'),
  paymentController.manualOptions
);
router.post(
  '/',
  authenticate,
  clientContext,
  authorize('CLIENT_OWNER', 'CLIENT_ADMIN'),
  validate(manualPaymentSchema),
  paymentController.create
);

export default router;
