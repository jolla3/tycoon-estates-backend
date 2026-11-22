import { depositService } from '../services/deposit.service.js';
import { apiResponse } from '../utils/apiResponse.js';

function idempotencyKeyFrom(req) {
  return req.get('Idempotency-Key') || req.get('idempotency-key') || req.body?.idempotencyKey || null;
}

export const depositController = {
  async get(req, res, next) {
    try {
      const { tenancyId, estateId } = req.query;
      const data = tenancyId
        ? await depositService.getExact(
          req.clientId, { tenantId: req.params.tenantId, tenancyId, estateId }, req.estateFilter
        )
        : await depositService.getForTenant(req.clientId, req.params.tenantId, req.estateFilter);
      apiResponse.success(res, data);
    } catch (err) {
      next(err);
    }
  },
  async require(req, res, next) {
    try {
      const dep = await depositService.ensureRequired(
        req.clientId,
        { tenantId: req.params.tenantId, tenancyId: req.body.tenancyId, estateId: req.body.estateId, requiredCents: req.body.requiredCents, moveInDate: req.body.moveInDate },
        req.currentUser,
        req.estateFilter
      );
      apiResponse.success(res, dep, 'Deposit requirement saved');
    } catch (err) {
      next(err);
    }
  },
  async pay(req, res, next) {
    try {
      const dep = await depositService.recordPayment(
        req.clientId,
        req.params.tenantId,
        req.body.amountCents,
        req.currentUser,
        req.estateFilter,
        { idempotencyKey: idempotencyKeyFrom(req), tenancyId: req.body.tenancyId, estateId: req.body.estateId }
      );
      apiResponse.success(res, dep, 'Deposit payment recorded');
    } catch (err) {
      next(err);
    }
  },
  async deduct(req, res, next) {
    try {
      const { tenancyId: _t, estateId: _e, ...deduction } = req.body;
      const dep = await depositService.addDeduction(
        req.clientId,
        req.params.tenantId,
        deduction,
        req.currentUser,
        req.estateFilter,
        { idempotencyKey: idempotencyKeyFrom(req), tenancyId: req.body.tenancyId, estateId: req.body.estateId }
      );
      apiResponse.success(res, dep, 'Deduction recorded');
    } catch (err) {
      next(err);
    }
  },
  async settle(req, res, next) {
    try {
      const data = await depositService.settleMoveOut(
        req.clientId,
        req.params.tenantId,
        req.currentUser,
        req.estateFilter,
        { tenancyId: req.body?.tenancyId, estateId: req.body?.estateId }
      );
      apiResponse.success(res, data, 'Deposit settled');
    } catch (err) {
      next(err);
    }
  },
};
