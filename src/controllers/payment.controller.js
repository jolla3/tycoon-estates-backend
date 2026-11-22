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

  async manualOptions(req, res, next) {
    try {
      apiResponse.success(
        res,
        await paymentService.manualOptions(req.clientId, req.estateFilter, req.query)
      );
    } catch (err) {
      next(err);
    }
  },

  async tenantContext(req, res, next) {
    try {
      apiResponse.success(
        res,
        await paymentService.tenantContext(req.clientId, req.estateFilter, req.query)
      );
    } catch (err) {
      next(err);
    }
  },

  async manualContext(req, res, next) {
    try {
      apiResponse.success(
        res,
        await paymentService.manualContext(req.clientId, req.estateFilter, req.query)
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
          receipt: result.receipt ?? null,
          payment: result.payment,
          payments: result.payments ?? [],
          allocations: result.allocations ?? [],
          reused: result.reused,
          tenancyId: result.tenancyId ?? result.payment?.tenancyId ?? null,
          tenantId: result.tenantId ?? result.payment?.tenantId ?? null,
          unappliedCents: result.unappliedCents ?? 0,
          remainingBalanceCents: result.remainingBalanceCents ?? null,
          balanceBeforeCents: result.balanceBeforeCents ?? null,
          balanceAfterCents: result.balanceAfterCents ?? null,
          creditBeforeCents: result.creditBeforeCents ?? null,
          creditAfterCents: result.creditAfterCents ?? null,
          outstandingBeforeCents: result.outstandingBeforeCents ?? null,
          outstandingAfterCents: result.outstandingAfterCents ?? null,
          plan: result.plan ?? null,
          tenant: result.tenant ?? null,
        },
        result.reused ? 'Payment already recorded (idempotent)' : 'Payment recorded',
        result.reused ? 200 : 201
      );
    } catch (err) {
      next(err);
    }
  },
};
