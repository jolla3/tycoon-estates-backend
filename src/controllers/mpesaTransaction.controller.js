import { mpesaTransactionService } from '../services/mpesaTransaction.service.js';
import { apiResponse } from '../utils/apiResponse.js';

export const mpesaTransactionController = {
  async list(req, res, next) {
    try {
      apiResponse.success(res, await mpesaTransactionService.list(req.clientId, req.estateFilter, req.query));
    } catch (err) {
      next(err);
    }
  },
};
