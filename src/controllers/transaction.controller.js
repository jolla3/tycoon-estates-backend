// src/controllers/transaction.controller.js
import { transactionService } from '../services/transaction.service.js';
import { audit } from '../services/audit.service.js';
import { apiResponse } from '../utils/apiResponse.js';

export const transactionController = {
  async list(req, res, next) {
    try { apiResponse.success(res, await transactionService.list(req.clientId, req.estateFilter, req.query)); }
    catch (err) { next(err); }
  },

  async unmatched(req, res, next) {
    try { apiResponse.success(res, await transactionService.unmatched(req.clientId, req.estateFilter)); }
    catch (err) { next(err); }
  },

  async assign(req, res, next) {
    try {
      const txn = await transactionService.assignToHouse(req.clientId, req.params.id, req.body.houseId, req.estateFilter);
      await audit({ clientId: req.clientId, userId: req.currentUser._id, action: 'PAYMENT_MANUALLY_ASSIGNED', resource: 'BankTransaction', resourceId: txn._id, metadata: { houseId: req.body.houseId }, ipAddress: req.ip, userAgent: req.headers['user-agent'] });
      apiResponse.success(res, txn, 'Transaction assigned');
    } catch (err) { next(err); }
  },
};
