import { Router } from 'express';
import { connectionController } from '../controllers/connection.controller.js';
import { authenticate } from '../middlewares/authenticate.js';
import { authorize } from '../middlewares/authorize.js';
import { clientContext } from '../middlewares/clientContext.js';
import { requireProduct } from '../middlewares/requireProduct.js';
import { validate } from '../middlewares/validate.js';
import { schemas } from '../utils/validators.js';

const router = Router();
const banking = requireProduct('BANKING');

router.get(
  '/',
  authenticate,
  clientContext,
  banking,
  connectionController.list
);
router.post(
  '/',
  authenticate,
  clientContext,
  banking,
  authorize('CLIENT_OWNER', 'CLIENT_ADMIN', 'SUPER_ADMIN'),
  validate(schemas.createBankConnection),
  connectionController.create
);
router.get(
  '/:id',
  authenticate,
  clientContext,
  banking,
  connectionController.get
);
router.post(
  '/:id/reauthorize',
  authenticate,
  clientContext,
  banking,
  authorize('CLIENT_OWNER', 'CLIENT_ADMIN', 'SUPER_ADMIN'),
  validate(schemas.reauthorizeBankConnection),
  connectionController.reauthorize
);
router.post(
  '/:id/disconnect',
  authenticate,
  clientContext,
  banking,
  authorize('CLIENT_OWNER', 'CLIENT_ADMIN', 'SUPER_ADMIN'),
  connectionController.disconnect
);

export default router;
