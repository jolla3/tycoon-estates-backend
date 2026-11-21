// src/routes/bank.routes.js
import { Router } from 'express';
import { bankController } from '../controllers/bank.controller.js';
import { authenticate } from '../middlewares/authenticate.js';
import { authorize } from '../middlewares/authorize.js';
import { clientContext } from '../middlewares/clientContext.js';
import { requireProduct } from '../middlewares/requireProduct.js';
import { validate } from '../middlewares/validate.js';
import { schemas } from '../utils/validators.js';

const router = Router();
const banking = requireProduct('BANKING');

router.get('/accounts', authenticate, clientContext, banking, bankController.list);
router.post('/accounts', authenticate, clientContext, banking, authorize('CLIENT_OWNER', 'CLIENT_ADMIN', 'SUPER_ADMIN'), validate(schemas.connectBankAccount), bankController.connect);
router.post('/accounts/:id/sync', authenticate, clientContext, banking, authorize('CLIENT_OWNER', 'CLIENT_ADMIN', 'SUPER_ADMIN'), bankController.sync);
router.get('/accounts/:id/statement', authenticate, clientContext, banking, authorize('CLIENT_OWNER', 'CLIENT_ADMIN', 'SUPER_ADMIN'), validate(schemas.dateRange, 'query'), bankController.statement);

export default router;
