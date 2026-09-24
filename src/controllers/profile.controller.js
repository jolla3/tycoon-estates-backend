// src/controllers/profile.controller.js
//
// Section 5 (V2): profile operations act ONLY on req.currentUser — never
// accept a target user id from the request. Never returns password
// hashes, session secrets, or any provider credentials.
import { profileService } from '../services/profile.service.js';
import { audit } from '../services/audit.service.js';
import { apiResponse } from '../utils/apiResponse.js';

export const profileController = {
  get(req, res) {
    const user = req.currentUser;
    apiResponse.success(res, {
      name: user.name,
      email: user.email,
      phone: user.phone,
      role: user.role,
      clientId: user.clientId,
      estateIds: user.estateIds,
      createdAt: user.createdAt,
      lastLoginAt: user.lastLoginAt,
    });
  },

  async update(req, res, next) {
    try {
      const user = await profileService.update(req.currentUser._id, req.body);
      await audit({ clientId: user.clientId, userId: user._id, action: 'PROFILE_UPDATED', ipAddress: req.ip, userAgent: req.headers['user-agent'] });
      apiResponse.success(res, { name: user.name, email: user.email, phone: user.phone }, 'Profile updated');
    } catch (err) { next(err); }
  },

  async changePassword(req, res, next) {
    try {
      const user = await profileService.changePassword(req.currentUser._id, req.body.currentPassword, req.body.newPassword);
      await audit({ clientId: user.clientId, userId: user._id, action: 'PASSWORD_CHANGED', ipAddress: req.ip, userAgent: req.headers['user-agent'] });
      apiResponse.success(res, {}, 'Password changed');
    } catch (err) { next(err); }
  },
};
