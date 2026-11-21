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

const tenderMethods = z.enum(['CASH', 'MPESA', 'BANK_TRANSFER', 'CHEQUE', 'OTHER']);

/** Ordinary manual payment: house + receipt. Ownership is resolved server-side. */
export const manualPaymentSchema = z.object({
  houseId: objectId,
  amountCents: z.coerce.number().int().positive(),
  paymentDate: z.string().min(1, 'paymentDate is required'),
  tenderMethod: tenderMethods,
  paymentReference: z.string().max(120).optional(),
  // Edge-case / legacy fields — ordinary UI does not send these.
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
  eligiblePage: z.coerce.number().int().min(1).max(10000).optional(),
  eligibleLimit: z.coerce.number().int().min(1).max(50).optional(),
  eligibleSearch: z.string().trim().max(80).optional(),
}).strict();

export const manualContextQuerySchema = z.object({
  houseId: objectId,
  paymentDate: z.string().optional(),
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
router.get(
  '/manual-context',
  authenticate,
  clientContext,
  authorize('CLIENT_OWNER', 'CLIENT_ADMIN'),
  validate(manualContextQuerySchema, 'query'),
  paymentController.manualContext
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
