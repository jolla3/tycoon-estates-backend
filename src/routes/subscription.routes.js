// src/routes/subscription.routes.js — /api/v1/subscription
import { Router } from 'express';
import { z } from 'zod';
import { subscriptionController } from '../controllers/subscription.controller.js';
import { authenticate } from '../middlewares/authenticate.js';
import { authorize } from '../middlewares/authorize.js';
import { clientContext } from '../middlewares/clientContext.js';
import { validate } from '../middlewares/validate.js';

const router = Router();

const upgradeSchema = z.object({
  plan: z.enum(['basic', 'pro']),
});

router.get('/', authenticate, clientContext, subscriptionController.get);
router.post(
  '/upgrade',
  authenticate,
  clientContext,
  authorize('CLIENT_OWNER', 'CLIENT_ADMIN'),
  validate(upgradeSchema),
  subscriptionController.upgrade
);

export default router;
