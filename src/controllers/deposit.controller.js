import { depositService } from '../services/deposit.service.js';
import { apiResponse } from '../utils/apiResponse.js';

export const depositController = {
  async get(req, res, next) {
    try {
      const data = await depositService.getForTenant(req.clientId, req.params.tenantId, req.estateFilter);
      apiResponse.success(res, data);
    } catch (err) {
      next(err);
    }
  },
  async require(req, res, next) {
    try {
      const dep = await depositService.ensureRequired(
        req.clientId,
        { tenantId: req.params.tenantId, requiredCents: req.body.requiredCents, moveInDate: req.body.moveInDate },
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
        req.estateFilter
      );
      apiResponse.success(res, dep, 'Deposit payment recorded');
    } catch (err) {
      next(err);
    }
  },
  async deduct(req, res, next) {
    try {
      const dep = await depositService.addDeduction(
        req.clientId,
        req.params.tenantId,
        req.body,
        req.currentUser,
        req.estateFilter
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
        req.estateFilter
      );
      apiResponse.success(res, data, 'Move-out settlement completed');
    } catch (err) {
      next(err);
    }
  },
};
