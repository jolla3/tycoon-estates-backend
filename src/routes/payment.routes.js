import { Router } from 'express';
import { z } from 'zod';
import { paymentController } from '../controllers/payment.controller.js';
import { authenticate } from '../middlewares/authenticate.js';
import { authorize } from '../middlewares/authorize.js';
import { clientContext } from '../middlewares/clientContext.js';
import { validate } from '../middlewares/validate.js';

const router = Router();

const objectId = z.string().regex(/^[a-f\d]{24}$/i, 'Invalid id');
const tenderMethods = z.enum(['CASH', 'MPESA', 'BANK_TRANSFER', 'CHEQUE', 'OTHER']);
const periodString = z.string().regex(/^\d{4}-(0[1-9]|1[0-2])$/);
const positiveIntegerQuery = z.string().regex(/^[1-9]\d*$/).transform(Number);
const dateOnly = z.string().regex(/^\d{4}-(0[1-9]|1[0-2])-(0[1-9]|[12]\d|3[01])$/);

export const paymentListQuerySchema = z.object({
  clientId: objectId.optional(),
  page: positiveIntegerQuery.refine((value) => value <= 10000).optional(),
  limit: positiveIntegerQuery.refine((value) => value <= 100).optional(),
  estateId: objectId.optional(),
  houseId: objectId.optional(),
  tenantId: objectId.optional(),
  startDate: dateOnly.optional(),
  endDate: dateOnly.optional(),
  origin: z.enum(['MANUAL', 'MPESA', 'BANK']).optional(),
  tenderMethod: tenderMethods.optional(),
  status: z.enum(['CONFIRMED']).optional(),
}).strict();


/** Ordinary manual payment: house + receipt. Ownership is resolved server-side. */
export const manualPaymentSchema = z.object({
  houseId: objectId,
  amountCents: z.coerce.number().int().positive(),
  paymentDate: z.string().min(1, 'paymentDate is required'),
  tenderMethod: tenderMethods,
  /** Client-generated once per intended submission; retries must reuse the same key. */
  idempotencyKey: z.string().trim().min(8).max(128),
  paymentReference: z.string().max(120).optional(),
  /** Explicit ownership: the operator picks tenant, then one of that tenant's tenancies. */
  tenantId: objectId,
  tenancyId: objectId,
  period: periodString.optional(),
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

export const tenantContextQuerySchema = z.object({
  tenantId: objectId,
  paymentDate: z.string().optional(),
}).strict();

router.get('/', authenticate, clientContext, validate(paymentListQuerySchema, 'query'), paymentController.list);
router.get(
  '/tenant-context',
  authenticate,
  clientContext,
  authorize('CLIENT_OWNER', 'CLIENT_ADMIN'),
  validate(tenantContextQuerySchema, 'query'),
  paymentController.tenantContext
);
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
