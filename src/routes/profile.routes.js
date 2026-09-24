// src/routes/profile.routes.js
import { Router } from 'express';
import { profileController } from '../controllers/profile.controller.js';
import { authenticate } from '../middlewares/authenticate.js';
import { validate } from '../middlewares/validate.js';
import { schemas } from '../utils/validators.js';

const router = Router();

router.get('/', authenticate, profileController.get);
router.patch('/', authenticate, validate(schemas.updateProfile), profileController.update);
router.post('/change-password', authenticate, validate(schemas.changePassword), profileController.changePassword);

export default router;
