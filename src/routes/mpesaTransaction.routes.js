import { Router } from 'express';
import { z } from 'zod';
import { mpesaTransactionController } from '../controllers/mpesaTransaction.controller.js';
import { authenticate } from '../middlewares/authenticate.js';
import { clientContext } from '../middlewares/clientContext.js';
import { requireProduct } from '../middlewares/requireProduct.js';
import { validate } from '../middlewares/validate.js';

const router = Router();

export const mpesaTransactionListSchema = z.object({
  estateId: z.string().regex(/^[a-f\\d]{24}$/i).optional(),
  page: z.coerce.number().int().min(1).optional(),
  limit: z.coerce.number().int().min(1).max(100).optional(),
  verificationState: z.enum(['UNVERIFIED', 'MATCHED', 'CONFLICT', 'MANUAL_REVIEW']).optional(),
  postingState: z.enum(['NOT_POSTED', 'PROCESSING', 'POSTED', 'FAILED_RETRYABLE', 'FAILED_TERMINAL']).optional(),
  businessShortCode: z.string().trim().min(1).max(20).optional(),
  startDate: z.coerce.date().optional(),
  endDate: z.coerce.date().optional(),
}).strict().refine((v) => !v.startDate || !v.endDate || v.startDate <= v.endDate, {
  message: 'startDate must be on or before endDate',
});

router.get('/', authenticate, clientContext, requireProduct('MPESA'), validate(mpesaTransactionListSchema, 'query'), mpesaTransactionController.list);

export default router;
