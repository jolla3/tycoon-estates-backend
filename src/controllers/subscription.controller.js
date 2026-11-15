// src/controllers/subscription.controller.js
// Client-scoped subscription view (read-only; upgrade retired). Identity always from session.
import { subscriptionService } from '../services/subscription.service.js';
import { apiResponse } from '../utils/apiResponse.js';

export const subscriptionController = {
  async get(req, res, next) {
    try {
      const sub = await subscriptionService.getPublic(req.clientId);
      apiResponse.success(res, {
        subscription: sub,
        plans: subscriptionService.catalog(),
      });
    } catch (err) {
      next(err);
    }
  },

  /**
   * Retired: plan/product authority belongs to the platform Manager
   * (PATCH /api/v1/platform/clients/:clientId/subscription). Never mutates.
   */
  async upgrade(req, res, next) {
    try {
      apiResponse.error(res, 'FORBIDDEN',
        'Subscription changes are managed by the platform. Contact your account manager.', 403);
    } catch (err) {
      next(err);
    }
  },
};
