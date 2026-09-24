// src/controllers/sms.controller.js
import { smsService } from '../services/sms.service.js';
import { apiResponse } from '../utils/apiResponse.js';

export const smsController = {
  async send(req, res, next) {
    try {
      // Resolve tenant/house → estate server-side. Never trust body.estateId.
      const { doc } = await smsService.sendIndividual(
        req.clientId,
        {
          tenantId: req.body.tenantId,
          houseId: req.body.houseId,
          message: req.body.message,
          forceResend: Boolean(req.body.forceResend),
        },
        req.estateFilter
      );
      apiResponse.success(res, { jobId: doc._id, status: doc.status }, 'SMS queued', 202);
    } catch (err) {
      next(err);
    }
  },

  async broadcast(req, res, next) {
    try {
      const result = await smsService.broadcast(
        req.clientId,
        {
          recipientGroup: req.body.recipientGroup,
          estateId: req.body.estateId,
          tenantIds: req.body.tenantIds,
          message: req.body.message,
          type: req.body.type || 'broadcast',
          period: req.body.period,
          forceResend: Boolean(req.body.forceResend),
          estateFilter: req.estateFilter,
        },
        {
          userId: req.currentUser?._id,
          ip: req.ip,
          userAgent: req.headers['user-agent'],
        }
      );
      apiResponse.success(res, result, 'Broadcast queued', 202);
    } catch (err) {
      next(err);
    }
  },

  async preview(req, res, next) {
    try {
      const data = await smsService.preview(req.clientId, { ...req.body, estateFilter: req.estateFilter });
      apiResponse.success(res, data, 'Preview generated');
    } catch (err) {
      next(err);
    }
  },

  async history(req, res, next) {
    try {
      apiResponse.success(res, await smsService.history(req.clientId, req.estateFilter));
    } catch (err) {
      next(err);
    }
  },
};
