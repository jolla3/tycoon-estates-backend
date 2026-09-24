// src/controllers/subscription.controller.js
// Client-scoped subscription view + upgrade. Identity always from session.
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

  async upgrade(req, res, next) {
    try {
      const plan = req.body?.plan;
      const sub = await subscriptionService.upgrade(
        req.clientId,
        plan,
        req.currentUser,
        { ip: req.ip, userAgent: req.headers['user-agent'] }
      );
      apiResponse.success(res, sub, 'Subscription upgraded');
    } catch (err) {
      next(err);
    }
  },
};
