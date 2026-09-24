import { paymentService } from '../services/payment.service.js';
import { apiResponse } from '../utils/apiResponse.js';

export const paymentController = {
  async list(req, res, next) {
    try {
      apiResponse.success(
        res,
        await paymentService.list(req.clientId, req.estateFilter, req.query)
      );
    } catch (err) {
      next(err);
    }
  },

  async create(req, res, next) {
    try {
      const result = await paymentService.recordManual(
        req.clientId,
        req.body,
        req.estateFilter,
        req.currentUser,
        { ip: req.ip, userAgent: req.headers['user-agent'] }
      );
      apiResponse.success(
        res,
        {
          payment: result.payment,
          allocations: result.allocations,
          reused: result.reused,
        },
        result.reused ? 'Payment already recorded (idempotent)' : 'Payment recorded',
        result.reused ? 200 : 201
      );
    } catch (err) {
      next(err);
    }
  },
};
