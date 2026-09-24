// src/routes/tenant.routes.js
import { Router } from 'express';
import { tenantController } from '../controllers/tenant.controller.js';
import { authenticate } from '../middlewares/authenticate.js';
import { authorize } from '../middlewares/authorize.js';
import { clientContext } from '../middlewares/clientContext.js';
import { validate } from '../middlewares/validate.js';
import { schemas } from '../utils/validators.js';

const router = Router();

router.get('/', authenticate, clientContext, tenantController.list);
router.get('/:id', authenticate, clientContext, tenantController.get);
router.post('/', authenticate, clientContext, authorize('CLIENT_OWNER', 'CLIENT_ADMIN'), validate(schemas.createTenant), tenantController.create);
router.patch('/:id', authenticate, clientContext, authorize('CLIENT_OWNER', 'CLIENT_ADMIN'), validate(schemas.updateTenant), tenantController.update);
router.post('/:id/move', authenticate, clientContext, authorize('CLIENT_OWNER', 'CLIENT_ADMIN'), validate(schemas.moveTenant), tenantController.move);

export default router;
