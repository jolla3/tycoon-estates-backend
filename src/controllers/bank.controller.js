// src/controllers/bank.controller.js
import { bankService } from '../services/bank.service.js';
import { audit } from '../services/audit.service.js';
import { apiResponse } from '../utils/apiResponse.js';

export const bankController = {
  async list(req, res, next) {
    try { apiResponse.success(res, await bankService.list(req.clientId, req.estateFilter)); }
    catch (err) { next(err); }
  },

  async connect(req, res, next) {
    try {
      const { estateId, ...data } = req.body;
      const account = await bankService.connectAccount(req.clientId, estateId, data);
      await audit({ clientId: req.clientId, estateId, userId: req.currentUser._id, action: 'BANK_ACCOUNT_CONNECTED', resource: 'BankAccount', resourceId: account.id || account._id, ipAddress: req.ip, userAgent: req.headers['user-agent'] });
      apiResponse.success(res, account, 'Bank account connected', 201);
    } catch (err) { next(err); }
  },

  async sync(req, res, next) {
    try {
      const result = await bankService.sync(req.clientId, req.params.id, req.estateFilter);
      await audit({ clientId: req.clientId, userId: req.currentUser._id, action: 'BANK_ACCOUNT_SYNCED', resource: 'BankAccount', resourceId: req.params.id, metadata: result, ipAddress: req.ip, userAgent: req.headers['user-agent'] });
      apiResponse.success(res, result, 'Sync complete');
    } catch (err) { next(err); }
  },

  async statement(req, res, next) {
    try {
      const { startDate, endDate } = req.query;
      const result = await bankService.importStatement(req.clientId, req.params.id, startDate, endDate, req.estateFilter);
      apiResponse.success(res, result, 'Statement imported');
    } catch (err) { next(err); }
  },
};
