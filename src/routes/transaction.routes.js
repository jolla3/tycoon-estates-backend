// src/routes/transaction.routes.js
import { Router } from 'express';
import { transactionController } from '../controllers/transaction.controller.js';
import { authenticate } from '../middlewares/authenticate.js';
import { authorize } from '../middlewares/authorize.js';
import { clientContext } from '../middlewares/clientContext.js';
import { requireProduct } from '../middlewares/requireProduct.js';
import { validate } from '../middlewares/validate.js';
import { schemas } from '../utils/validators.js';

const router = Router();
const banking = requireProduct('BANKING');

router.get('/unmatched', authenticate, clientContext, banking, transactionController.unmatched);
router.get('/', authenticate, clientContext, banking, transactionController.list);
router.post('/:id/assign', authenticate, clientContext, banking, authorize('CLIENT_OWNER', 'CLIENT_ADMIN'), validate(schemas.assignTransaction), transactionController.assign);

export default router;
