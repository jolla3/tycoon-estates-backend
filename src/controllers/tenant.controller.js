// src/controllers/tenant.controller.js
import { tenantService } from '../services/tenant.service.js';
import { audit } from '../services/audit.service.js';
import { apiResponse } from '../utils/apiResponse.js';

export const tenantController = {
  async get(req, res, next) {
    try {
      const tenant = await tenantService.get(req.clientId, req.params.id, req.estateFilter);
      apiResponse.success(res, tenant);
    } catch (err) { next(err); }
  },

  async list(req, res, next) {
    try { apiResponse.success(res, await tenantService.list(req.clientId, req.estateFilter)); }
    catch (err) { next(err); }
  },

  async create(req, res, next) {
    try {
      const tenant = await tenantService.create(req.clientId, req.body);
      await audit({ clientId: req.clientId, estateId: tenant.estateId, userId: req.currentUser._id, action: 'TENANT_CREATED', resource: 'Tenant', resourceId: tenant._id, ipAddress: req.ip, userAgent: req.headers['user-agent'] });
      apiResponse.success(res, tenant, 'Tenant created', 201);
    } catch (err) { next(err); }
  },

  async update(req, res, next) {
    try {
      // req.body is already restricted to schemas.updateTenant's field
      // set (name/phone/status/moveOutDate) — no houseId here, see move().
      const tenant = await tenantService.update(req.clientId, req.params.id, req.body, req.estateFilter);
      await audit({ clientId: req.clientId, estateId: tenant.estateId, userId: req.currentUser._id, action: 'TENANT_UPDATED', resource: 'Tenant', resourceId: tenant._id, ipAddress: req.ip, userAgent: req.headers['user-agent'] });
      apiResponse.success(res, tenant, 'Tenant updated');
    } catch (err) { next(err); }
  },

  async move(req, res, next) {
    try {
      const tenant = await tenantService.moveToHouse(req.clientId, req.params.id, req.body.houseId, req.estateFilter);
      await audit({ clientId: req.clientId, estateId: tenant.estateId, userId: req.currentUser._id, action: 'TENANT_MOVED', resource: 'Tenant', resourceId: tenant._id, metadata: { newHouseId: req.body.houseId }, ipAddress: req.ip, userAgent: req.headers['user-agent'] });
      apiResponse.success(res, tenant, 'Tenant moved');
    } catch (err) { next(err); }
  },
};
