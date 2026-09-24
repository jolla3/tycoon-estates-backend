// src/routes/report.routes.js
import { Router } from 'express';
import { reportController } from '../controllers/report.controller.js';
import { authenticate } from '../middlewares/authenticate.js';
import { clientContext } from '../middlewares/clientContext.js';

const router = Router();

router.get('/dashboard', authenticate, clientContext, reportController.dashboard);
router.get('/monthly', authenticate, clientContext, reportController.monthly);
router.get('/arrears', authenticate, clientContext, reportController.arrears);
router.get('/payments', authenticate, clientContext, reportController.payments);
router.get('/bank-transactions', authenticate, clientContext, reportController.bankTransactions);
router.get('/sms', authenticate, clientContext, reportController.sms);
router.get('/billed-vs-paid', authenticate, clientContext, reportController.billedVsPaid);
router.get('/management', authenticate, clientContext, reportController.management);

export default router;
