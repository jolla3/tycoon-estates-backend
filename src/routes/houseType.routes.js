import { Router } from 'express';
import { z } from 'zod';
import { houseTypeController } from '../controllers/houseType.controller.js';
import { authenticate } from '../middlewares/authenticate.js';
import { authorize } from '../middlewares/authorize.js';
import { clientContext } from '../middlewares/clientContext.js';
import { validate } from '../middlewares/validate.js';

const router = Router();

const billingLine = z.object({
  chargeType: z.enum(['RENT', 'WATER', 'ELECTRICITY', 'OTHER']),
  description: z.string().max(200).optional(),
  amountCents: z.coerce.number().int().min(0),
  dueDay: z.coerce.number().int().min(1).max(31).optional(),
});

const objectId = z.string().regex(/^[a-f\d]{24}$/i, 'Invalid estateId');

// estateId is required on create: the service enforces estate ownership, but the
// validator previously stripped it (validate() replaces req.body with parsed data).
export const houseTypeCreateSchema = z.object({
  estateId: objectId,
  name: z.string().min(1).max(80),
  description: z.string().max(500).optional(),
  defaultRentCents: z.coerce.number().int().min(0).optional(),
  defaultDueDay: z.coerce.number().int().min(1).max(31).optional(),
  defaultBilling: z.array(billingLine).optional(),
  isActive: z.boolean().optional(),
  // Versioned plan terms: validate() strips unknown keys, so these must be declared
  // or the service never receives them and silently falls back to its defaults.
  effectiveFromPeriod: z.string().regex(/^\d{4}-(0[1-9]|1[0-2])$/, 'Use YYYY-MM').optional(),
  changeReason: z.string().trim().min(1).max(500).optional(),
});

// Estate ownership is immutable. estateId stays in the update schema (validated, optional) so
// the service can REJECT an attempted move with a 422 instead of silently ignoring it.
export const houseTypeUpdateSchema = houseTypeCreateSchema.partial();

router.get('/', authenticate, clientContext, houseTypeController.list);
router.get('/:id/workspace', authenticate, clientContext, houseTypeController.workspace);
router.get('/:id', authenticate, clientContext, houseTypeController.get);
router.post(
  '/',
  authenticate,
  clientContext,
  authorize('CLIENT_OWNER', 'CLIENT_ADMIN'),
  validate(houseTypeCreateSchema),
  houseTypeController.create
);
router.patch(
  '/:id',
  authenticate,
  clientContext,
  authorize('CLIENT_OWNER', 'CLIENT_ADMIN'),
  validate(houseTypeUpdateSchema),
  houseTypeController.update
);
router.post(
  '/:id/deactivate',
  authenticate,
  clientContext,
  authorize('CLIENT_OWNER', 'CLIENT_ADMIN'),
  houseTypeController.deactivate
);

export default router;
