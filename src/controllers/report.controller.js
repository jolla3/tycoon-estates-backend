// src/controllers/report.controller.js
import { reportService } from '../services/report.service.js';
import { apiResponse } from '../utils/apiResponse.js';
import { dateUtil } from '../utils/date.js';

export const reportController = {
  async dashboard(req, res, next) {
    try { apiResponse.success(res, await reportService.dashboard(req.clientId, req.estateFilter, req.query.period)); }
    catch (err) { next(err); }
  },
  async monthly(req, res, next) {
    try { apiResponse.success(res, await reportService.monthly(req.clientId, req.estateFilter, req.query.period)); }
    catch (err) { next(err); }
  },
  async arrears(req, res, next) {
    try { apiResponse.success(res, await reportService.arrears(req.clientId, req.estateFilter, req.query.period || dateUtil.currentPeriod())); }
    catch (err) { next(err); }
  },
  async payments(req, res, next) {
    try { apiResponse.success(res, await reportService.payments(req.clientId, req.estateFilter, req.query)); }
    catch (err) { next(err); }
  },
  async bankTransactions(req, res, next) {
    try { apiResponse.success(res, await reportService.bankTransactions(req.clientId, req.estateFilter, req.query.period)); }
    catch (err) { next(err); }
  },
  async sms(req, res, next) {
    try { apiResponse.success(res, await reportService.sms(req.clientId, req.estateFilter)); }
    catch (err) { next(err); }
  },
  async billedVsPaid(req, res, next) {
    try {
      apiResponse.success(
        res,
        await reportService.billedVsPaid(req.clientId, req.estateFilter, req.query.period)
      );
    } catch (err) {
      next(err);
    }
  },
  async management(req, res, next) {
    try {
      apiResponse.success(
        res,
        await reportService.managementSummary(req.clientId, req.estateFilter, req.query.period)
      );
    } catch (err) {
      next(err);
    }
  },
};
