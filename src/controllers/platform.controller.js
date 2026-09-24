// src/controllers/platform.controller.js
// SUPER_ADMIN-only platform control plane. Authorization is enforced on
// the route layer (authorize('SUPER_ADMIN')); this controller assumes it.

import { platformService } from '../services/platform.service.js';
import { apiResponse } from '../utils/apiResponse.js';

function meta(req) {
  return { ip: req.ip, userAgent: req.headers['user-agent'] };
}

export const platformController = {
  async overview(req, res, next) {
    try {
      apiResponse.success(res, await platformService.overview());
    } catch (err) {
      next(err);
    }
  },

  async health(req, res, next) {
    try {
      apiResponse.success(res, await platformService.systemHealth());
    } catch (err) {
      next(err);
    }
  },

  async listClients(req, res, next) {
    try {
      const isActive =
        req.query.isActive === 'true' ? true : req.query.isActive === 'false' ? false : undefined;
      apiResponse.success(
        res,
        await platformService.listClients({
          page: parseInt(req.query.page || '1', 10),
          limit: parseInt(req.query.limit || '50', 10),
          isActive,
        })
      );
    } catch (err) {
      next(err);
    }
  },

  async getClient(req, res, next) {
    try {
      apiResponse.success(res, await platformService.getClient(req.params.clientId));
    } catch (err) {
      next(err);
    }
  },

  async provisionClient(req, res, next) {
    try {
      const result = await platformService.provisionClient(req.body, req.currentUser, meta(req));
      apiResponse.success(res, result, 'Client provisioned', 201);
    } catch (err) {
      next(err);
    }
  },

  async updateClient(req, res, next) {
    try {
      const client = await platformService.updateClient(
        req.params.clientId,
        req.body,
        req.currentUser,
        meta(req)
      );
      apiResponse.success(res, client, 'Client updated');
    } catch (err) {
      next(err);
    }
  },

  async activateClient(req, res, next) {
    try {
      const client = await platformService.activateClient(
        req.params.clientId,
        req.currentUser,
        meta(req)
      );
      apiResponse.success(res, client, 'Client activated');
    } catch (err) {
      next(err);
    }
  },

  async deactivateClient(req, res, next) {
    try {
      const client = await platformService.deactivateClient(
        req.params.clientId,
        req.currentUser,
        meta(req)
      );
      apiResponse.success(res, client, 'Client deactivated');
    } catch (err) {
      next(err);
    }
  },

  async listUsers(req, res, next) {
    try {
      const isActive =
        req.query.isActive === 'true' ? true : req.query.isActive === 'false' ? false : undefined;
      apiResponse.success(
        res,
        await platformService.listUsers({
          page: parseInt(req.query.page || '1', 10),
          limit: parseInt(req.query.limit || '50', 10),
          role: req.query.role,
          clientId: req.query.clientId,
          isActive,
        })
      );
    } catch (err) {
      next(err);
    }
  },

  async listAudit(req, res, next) {
    try {
      apiResponse.success(
        res,
        await platformService.listAudit({
          page: parseInt(req.query.page || '1', 10),
          limit: parseInt(req.query.limit || '50', 10),
          action: req.query.action,
          clientId: req.query.clientId,
        })
      );
    } catch (err) {
      next(err);
    }
  },

  async listSubscriptions(req, res, next) {
    try {
      apiResponse.success(
        res,
        await platformService.listSubscriptions({
          page: parseInt(req.query.page || '1', 10),
          limit: parseInt(req.query.limit || '50', 10),
          status: req.query.status,
        })
      );
    } catch (err) {
      next(err);
    }
  },
};
