// src/controllers/house.controller.js
import { houseService } from '../services/house.service.js';
import { houseBillingConfigService } from '../services/houseBillingConfig.service.js';
import { audit } from '../services/audit.service.js';
import { apiResponse } from '../utils/apiResponse.js';

export const houseController = {
  async get(req, res, next) {
    try {
      const house = await houseService.get(req.clientId, req.params.id, req.estateFilter);
      apiResponse.success(res, house);
    } catch (err) { next(err); }
  },

  async list(req, res, next) {
    try {
      apiResponse.success(res, await houseService.list(req.clientId, req.estateFilter, req.query));
    } catch (err) {
      next(err);
    }
  },

  async create(req, res, next) {
    try {
      const { estateId, ...data } = req.body;
      const house = await houseService.create(req.clientId, estateId, data);
      await audit({
        clientId: req.clientId,
        estateId,
        userId: req.currentUser._id,
        action: 'HOUSE_CREATED',
        resource: 'House',
        resourceId: house._id,
        ipAddress: req.ip,
        userAgent: req.headers['user-agent'],
      });
      apiResponse.success(res, house, 'House created', 201);
    } catch (err) {
      next(err);
    }
  },

  async update(req, res, next) {
    try {
      const house = await houseService.update(req.clientId, req.params.id, req.body, req.estateFilter);
      await audit({
        clientId: req.clientId,
        estateId: house.estateId,
        userId: req.currentUser._id,
        action: 'HOUSE_UPDATED',
        resource: 'House',
        resourceId: house._id,
        ipAddress: req.ip,
        userAgent: req.headers['user-agent'],
      });
      apiResponse.success(res, house, 'House updated');
    } catch (err) {
      next(err);
    }
  },

  async listBillingConfig(req, res, next) {
    try {
      apiResponse.success(res, await houseBillingConfigService.list(req.clientId, req.params.id, req.estateFilter));
    } catch (err) {
      next(err);
    }
  },

  async upsertBillingConfig(req, res, next) {
    try {
      const doc = await houseBillingConfigService.upsert(req.clientId, req.params.id, req.body, req.estateFilter);
      await audit({
        clientId: req.clientId,
        estateId: doc.estateId,
        userId: req.currentUser._id,
        action: 'BILLING_CONFIGURATION_CHANGED',
        resource: 'HouseBillingConfig',
        resourceId: doc._id,
        metadata: { chargeType: doc.chargeType, amountCents: doc.amountCents },
        ipAddress: req.ip,
        userAgent: req.headers['user-agent'],
      });
      apiResponse.success(res, doc, 'Billing configuration saved');
    } catch (err) {
      next(err);
    }
  },

  async deactivateBillingConfig(req, res, next) {
    try {
      const doc = await houseBillingConfigService.deactivate(
        req.clientId,
        req.params.id,
        req.params.chargeType,
        req.estateFilter
      );
      await audit({
        clientId: req.clientId,
        estateId: doc.estateId,
        userId: req.currentUser._id,
        action: 'BILLING_CONFIGURATION_CHANGED',
        resource: 'HouseBillingConfig',
        resourceId: doc._id,
        metadata: { chargeType: doc.chargeType, isActive: false },
        ipAddress: req.ip,
        userAgent: req.headers['user-agent'],
      });
      apiResponse.success(res, doc, 'Billing configuration deactivated');
    } catch (err) {
      next(err);
    }
  },
};
