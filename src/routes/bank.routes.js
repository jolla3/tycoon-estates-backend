// src/routes/bank.routes.js
import { Router } from 'express';
import { bankController } from '../controllers/bank.controller.js';
import { authenticate } from '../middlewares/authenticate.js';
import { authorize } from '../middlewares/authorize.js';
import { clientContext } from '../middlewares/clientContext.js';
import { validate } from '../middlewares/validate.js';
import { schemas } from '../utils/validators.js';

const router = Router();

router.get('/accounts', authenticate, clientContext, bankController.list);
router.post('/accounts', authenticate, clientContext, authorize('CLIENT_OWNER', 'CLIENT_ADMIN'), validate(schemas.connectBankAccount), bankController.connect);
router.post('/accounts/:id/sync', authenticate, clientContext, authorize('CLIENT_OWNER', 'CLIENT_ADMIN'), bankController.sync);
router.get('/accounts/:id/statement', authenticate, clientContext, authorize('CLIENT_OWNER', 'CLIENT_ADMIN'), validate(schemas.dateRange, 'query'), bankController.statement);

export default router;
