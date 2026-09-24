// src/routes/sms.routes.js
import { Router } from 'express';
import { z } from 'zod';
import { smsController } from '../controllers/sms.controller.js';
import { authenticate } from '../middlewares/authenticate.js';
import { authorize } from '../middlewares/authorize.js';
import { clientContext } from '../middlewares/clientContext.js';
import { validate } from '../middlewares/validate.js';
import { smsRateLimiter } from '../middlewares/rateLimiter.js';
import { schemas } from '../utils/validators.js';

const router = Router();

const broadcastSchema = z
  .object({
    recipientGroup: z.enum(['ALL_TENANTS', 'ESTATE', 'SELECTED_TENANTS', 'ARREARS', 'OUTSTANDING']),
    estateId: z.string().min(1).optional(),
    tenantIds: z.array(z.string().min(1)).optional(),
    message: z.string().max(1000).optional(),
    type: z.enum(['broadcast', 'billing_notification', 'arrears_notice', 'rent_reminder', 'custom']).optional(),
    period: z.string().regex(/^\d{4}-\d{2}$/).optional(),
    forceResend: z.boolean().optional(),
  })
  .superRefine((data, ctx) => {
    const isCustom = !data.type || data.type === 'broadcast' || data.type === 'custom';
    if (isCustom && (!data.message || !String(data.message).trim())) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'Message is required for custom/general announcements',
        path: ['message'],
      });
    }
  });

const previewSchema = z.object({
  template: z
    .enum(['billing_notification', 'rent_reminder', 'arrears_notice', 'payment_confirmation'])
    .optional(),
  tenantId: z.string().min(1).optional(),
  houseId: z.string().min(1).optional(),
  period: z.string().regex(/^\d{4}-\d{2}$/).optional(),
  tenantName: z.string().optional(),
  houseNumber: z.string().optional(),
  phone: z.string().optional(),
  rentCents: z.number().int().optional(),
  waterCents: z.number().int().optional(),
  electricityCents: z.number().int().optional(),
  otherCents: z.number().int().optional(),
  previousArrearsCents: z.number().int().optional(),
  paidCents: z.number().int().optional(),
  totalOutstandingCents: z.number().int().optional(),
  dueDate: z.string().optional(),
});

router.post(
  '/send',
  authenticate,
  clientContext,
  authorize('CLIENT_OWNER', 'CLIENT_ADMIN', 'STAFF'),
  smsRateLimiter,
  validate(schemas.sendSms),
  smsController.send
);
router.post(
  '/broadcast',
  authenticate,
  clientContext,
  authorize('CLIENT_OWNER', 'CLIENT_ADMIN'),
  smsRateLimiter,
  validate(broadcastSchema),
  smsController.broadcast
);
router.post(
  '/preview',
  authenticate,
  clientContext,
  authorize('CLIENT_OWNER', 'CLIENT_ADMIN', 'STAFF'),
  validate(previewSchema),
  smsController.preview
);
router.get('/history', authenticate, clientContext, smsController.history);

export default router;
