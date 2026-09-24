import { Router } from 'express';
import { estateController } from '../controllers/estate.controller.js';
import { authenticate } from '../middlewares/authenticate.js';
import { authorize } from '../middlewares/authorize.js';
import { clientContext } from '../middlewares/clientContext.js';

const router = Router();

router.get('/', authenticate, clientContext, estateController.list);
router.get('/:id/workspace', authenticate, clientContext, estateController.workspace);
router.get('/:id', authenticate, clientContext, estateController.get);
router.post('/', authenticate, clientContext, authorize('CLIENT_OWNER', 'CLIENT_ADMIN'), estateController.create);
router.patch('/:id', authenticate, clientContext, authorize('CLIENT_OWNER', 'CLIENT_ADMIN'), estateController.update);

export default router;
