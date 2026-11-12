import { Router } from 'express';
import { connectionController } from '../controllers/connection.controller.js';
import { authenticate } from '../middlewares/authenticate.js';
import { authorize } from '../middlewares/authorize.js';
import { clientContext } from '../middlewares/clientContext.js';
import { validate } from '../middlewares/validate.js';
import { schemas } from '../utils/validators.js';

const router = Router();

router.get(
  '/',
  authenticate,
  clientContext,
  connectionController.list
);
router.post(
  '/',
  authenticate,
  clientContext,
  authorize('CLIENT_OWNER', 'CLIENT_ADMIN'),
  validate(schemas.createBankConnection),
  connectionController.create
);
router.get(
  '/:id',
  authenticate,
  clientContext,
  connectionController.get
);
router.post(
  '/:id/reauthorize',
  authenticate,
  clientContext,
  authorize('CLIENT_OWNER', 'CLIENT_ADMIN'),
  validate(schemas.reauthorizeBankConnection),
  connectionController.reauthorize
);
router.post(
  '/:id/disconnect',
  authenticate,
  clientContext,
  authorize('CLIENT_OWNER', 'CLIENT_ADMIN'),
  connectionController.disconnect
);

export default router;
