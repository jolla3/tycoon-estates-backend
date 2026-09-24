import { houseTypeService } from '../services/houseType.service.js';
import { audit } from '../services/audit.service.js';
import { apiResponse } from '../utils/apiResponse.js';

export const houseTypeController = {
  async list(req, res, next) {
    try {
      const includeInactive = req.query.includeInactive === 'true';
      const items = await houseTypeService.list(req.clientId, { includeInactive });
      apiResponse.success(res, items);
    } catch (err) {
      next(err);
    }
  },

  async get(req, res, next) {
    try {
      const item = await houseTypeService.get(req.clientId, req.params.id);
      apiResponse.success(res, item);
    } catch (err) {
      next(err);
    }
  },

  async workspace(req, res, next) {
    try {
      const data = await houseTypeService.workspace(req.clientId, req.params.id, {
        estateId: req.query.estateId || null,
        estateFilter: req.estateFilter,
      });
      apiResponse.success(res, data);
    } catch (err) {
      next(err);
    }
  },

  async create(req, res, next) {
    try {
      const item = await houseTypeService.create(req.clientId, req.body);
      await audit({
        clientId: req.clientId,
        userId: req.currentUser._id,
        action: 'HOUSE_TYPE_CREATED',
        resource: 'HouseType',
        resourceId: item._id,
        ipAddress: req.ip,
        userAgent: req.headers['user-agent'],
      });
      apiResponse.success(res, item, 'House type created', 201);
    } catch (err) {
      next(err);
    }
  },

  async update(req, res, next) {
    try {
      const item = await houseTypeService.update(req.clientId, req.params.id, req.body);
      await audit({
        clientId: req.clientId,
        userId: req.currentUser._id,
        action: 'HOUSE_TYPE_UPDATED',
        resource: 'HouseType',
        resourceId: item._id,
        ipAddress: req.ip,
        userAgent: req.headers['user-agent'],
      });
      apiResponse.success(res, item, 'House type updated');
    } catch (err) {
      next(err);
    }
  },

  async deactivate(req, res, next) {
    try {
      const item = await houseTypeService.deactivate(req.clientId, req.params.id);
      await audit({
        clientId: req.clientId,
        userId: req.currentUser._id,
        action: 'HOUSE_TYPE_DEACTIVATED',
        resource: 'HouseType',
        resourceId: item._id,
        ipAddress: req.ip,
        userAgent: req.headers['user-agent'],
      });
      apiResponse.success(res, item, 'House type deactivated');
    } catch (err) {
      next(err);
    }
  },
};
