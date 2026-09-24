// src/controllers/user.controller.js
//
// Staff management. Every query is scoped by req.clientId from
// clientContext — never from the request body.
import mongoose from 'mongoose';
import { User } from '../models/User.js';
import { authService } from '../services/auth.service.js';
import { audit } from '../services/audit.service.js';
import { apiResponse } from '../utils/apiResponse.js';
import { Errors } from '../utils/errors.js';

function toStaffDto(user) {
  if (!user) return null;
  const u = typeof user.toObject === 'function' ? user.toObject() : user;
  return {
    _id: String(u._id),
    id: String(u._id),
    name: u.name,
    email: u.email,
    phone: u.phone,
    role: u.role,
    isActive: !!u.isActive,
    estateIds: (u.estateIds || []).map(String),
    createdAt: u.createdAt,
  };
}

function assertValidObjectId(id) {
  if (!mongoose.Types.ObjectId.isValid(id)) {
    throw Errors.InvalidRequest('Invalid staff id');
  }
}

export const userController = {
  async list(req, res, next) {
    try {
      const users = await User.find({ clientId: req.clientId }).select('-passwordHash').lean();
      apiResponse.success(res, users.map(toStaffDto));
    } catch (err) {
      next(err);
    }
  },

  async create(req, res, next) {
    try {
      const staff = await authService.createStaff(req.clientId, req.body);
      await audit({
        clientId: req.clientId,
        userId: req.currentUser._id,
        action: 'STAFF_CREATED',
        resource: 'User',
        resourceId: staff._id,
        ipAddress: req.ip,
        userAgent: req.headers['user-agent'],
      });
      apiResponse.success(res, { userId: staff._id }, 'Staff member created', 201);
    } catch (err) {
      next(err);
    }
  },

  async update(req, res, next) {
    try {
      assertValidObjectId(req.params.id);
      const staff = await authService.updateStaff(req.clientId, req.params.id, req.body);
      await audit({
        clientId: req.clientId,
        userId: req.currentUser._id,
        action: 'STAFF_UPDATED',
        resource: 'User',
        resourceId: staff._id,
        ipAddress: req.ip,
        userAgent: req.headers['user-agent'],
      });
      apiResponse.success(res, toStaffDto(staff), 'Staff member updated');
    } catch (err) {
      next(err);
    }
  },

  async deactivate(req, res, next) {
    try {
      assertValidObjectId(req.params.id);
      if (String(req.currentUser._id) === String(req.params.id)) {
        throw Errors.InvalidRequest('You cannot deactivate your own account');
      }
      const staff = await User.findOneAndUpdate(
        {
          _id: req.params.id,
          clientId: req.clientId,
          role: { $in: ['STAFF', 'CLIENT_ADMIN'] },
        },
        { $set: { isActive: false } },
        { new: true }
      ).select('-passwordHash');
      if (!staff) throw Errors.NotFound('Staff member not found in your client');
      await audit({
        clientId: req.clientId,
        userId: req.currentUser._id,
        action: 'STAFF_DEACTIVATED',
        resource: 'User',
        resourceId: staff._id,
        ipAddress: req.ip,
        userAgent: req.headers['user-agent'],
      });
      apiResponse.success(res, toStaffDto(staff), 'Staff member deactivated');
    } catch (err) {
      next(err);
    }
  },

  async activate(req, res, next) {
    try {
      assertValidObjectId(req.params.id);
      const staff = await User.findOneAndUpdate(
        {
          _id: req.params.id,
          clientId: req.clientId,
          role: { $in: ['STAFF', 'CLIENT_ADMIN'] },
        },
        { $set: { isActive: true } },
        { new: true }
      ).select('-passwordHash');
      if (!staff) throw Errors.NotFound('Staff member not found in your client');
      await audit({
        clientId: req.clientId,
        userId: req.currentUser._id,
        action: 'STAFF_ACTIVATED',
        resource: 'User',
        resourceId: staff._id,
        ipAddress: req.ip,
        userAgent: req.headers['user-agent'],
      });
      apiResponse.success(res, toStaffDto(staff), 'Staff member activated');
    } catch (err) {
      next(err);
    }
  },
};
