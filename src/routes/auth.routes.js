// src/routes/auth.routes.js
import { Router } from 'express';
import { authController } from '../controllers/auth.controller.js';
import { authenticate } from '../middlewares/authenticate.js';
import { validate } from '../middlewares/validate.js';
import { authRateLimiter } from '../middlewares/rateLimiter.js';
import { schemas } from '../utils/validators.js';

const router = Router();

// Public self-signup is DISABLED for tender/customer deployment.
// New clients are provisioned only by SUPER_ADMIN via
// POST /api/v1/platform/clients (platform control plane).
// The signup handler remains in auth.controller/service for potential
// future controlled re-enablement; the route is intentionally not mounted.
// router.post('/signup', authRateLimiter, validate(schemas.signup), authController.signup);

router.post('/login', authRateLimiter, validate(schemas.login), authController.login);
router.post('/logout', authenticate, authController.logout);
router.get('/me', authenticate, authController.me);
router.post('/refresh', authenticate, authController.refresh);

export default router;
