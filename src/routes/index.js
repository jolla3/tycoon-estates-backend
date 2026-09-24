// src/routes/index.js — mounts every versioned route module under /api/v1.
import { Router } from 'express';

import authRoutes from './auth.routes.js';
import profileRoutes from './profile.routes.js';
import estateRoutes from './estate.routes.js';
import houseRoutes from './house.routes.js';
import tenantRoutes from './tenant.routes.js';
import paymentRoutes from './payment.routes.js';
import bankRoutes from './bank.routes.js';
import transactionRoutes from './transaction.routes.js';
import smsRoutes from './sms.routes.js';
import reportRoutes from './report.routes.js';
import depositRoutes from './deposit.routes.js';
import userRoutes from './user.routes.js';
import platformRoutes from './platform.routes.js';
import subscriptionRoutes from './subscription.routes.js';
import houseTypeRoutes from './houseType.routes.js';
import billingRoutes from './billing.routes.js';

const router = Router();

router.use('/auth', authRoutes);
router.use('/profile', profileRoutes);
router.use('/estates', estateRoutes);
router.use('/houses', houseRoutes);
router.use('/tenants', tenantRoutes);
router.use('/payments', paymentRoutes);
router.use('/bank', bankRoutes);
router.use('/transactions', transactionRoutes);
router.use('/sms', smsRoutes);
router.use('/reports', reportRoutes);
router.use('/deposits', depositRoutes);
router.use('/users', userRoutes);
router.use('/platform', platformRoutes);
router.use('/subscription', subscriptionRoutes);
router.use('/house-types', houseTypeRoutes);
router.use('/billing', billingRoutes);

export default router;
