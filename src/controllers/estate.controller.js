import { estateService } from '../services/estate.service.js';
import { audit } from '../services/audit.service.js';
import { apiResponse } from '../utils/apiResponse.js';

export const estateController = {
  async list(req, res, next) {
    try {
      const estates = await estateService.list(req.clientId, req.estateFilter);
      apiResponse.success(res, estates);
    } catch (err) {
      next(err);
    }
  },

  async get(req, res, next) {
    try {
      const estate = await estateService.get(req.clientId, req.params.id, req.estateFilter);
      apiResponse.success(res, estate);
    } catch (err) {
      next(err);
    }
  },

  async workspace(req, res, next) {
    try {
      const data = await estateService.workspace(req.clientId, req.params.id, req.estateFilter);
      apiResponse.success(res, data);
    } catch (err) {
      next(err);
    }
  },

  async create(req, res, next) {
    try {
      const estate = await estateService.create(req.clientId, req.body);
      await audit({
        clientId: req.clientId,
        userId: req.currentUser._id,
        action: 'ESTATE_CREATED',
        resource: 'Estate',
        resourceId: estate._id,
        ipAddress: req.ip,
        userAgent: req.headers['user-agent'],
      });
      apiResponse.success(res, estate, 'Estate created', 201);
    } catch (err) {
      next(err);
    }
  },

  async update(req, res, next) {
    try {
      const estate = await estateService.update(
        req.clientId,
        req.params.id,
        req.body,
        req.estateFilter
      );
      await audit({
        clientId: req.clientId,
        userId: req.currentUser._id,
        action: 'ESTATE_UPDATED',
        resource: 'Estate',
        resourceId: estate._id,
        ipAddress: req.ip,
        userAgent: req.headers['user-agent'],
      });
      apiResponse.success(res, estate, 'Estate updated');
    } catch (err) {
      next(err);
    }
  },
};
