import { connectionService } from '../services/connection.service.js';
import { apiResponse } from '../utils/apiResponse.js';

export const connectionController = {
  async list(req, res, next) {
    try {
      apiResponse.success(res, await connectionService.list(req.clientId));
    } catch (err) { next(err); }
  },

  async create(req, res, next) {
    try {
      const connection = await connectionService.create(
        req.clientId,
        req.body,
        req.currentUser?._id
      );
      apiResponse.success(res, connection, 'Bank connection created', 201);
    } catch (err) { next(err); }
  },

  async get(req, res, next) {
    try {
      apiResponse.success(res, await connectionService.getPublic(req.clientId, req.params.id));
    } catch (err) { next(err); }
  },

  async reauthorize(req, res, next) {
    try {
      const connection = await connectionService.reauthorize(
        req.clientId,
        req.params.id,
        req.body.credentialMaterial,
        req.currentUser?._id
      );
      apiResponse.success(res, connection, 'Bank connection reauthorization attempted');
    } catch (err) { next(err); }
  },

  async disconnect(req, res, next) {
    try {
      const connection = await connectionService.disconnect(
        req.clientId,
        req.params.id,
        req.currentUser?._id
      );
      apiResponse.success(res, connection, 'Bank connection disconnected');
    } catch (err) { next(err); }
  },
};
