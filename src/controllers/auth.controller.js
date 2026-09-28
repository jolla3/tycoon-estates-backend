// src/controllers/auth.controller.js — thin: validate -> service -> respond.
import { authService } from '../services/auth.service.js';
import { audit } from '../services/audit.service.js';
import { apiResponse } from '../utils/apiResponse.js';

export const authController = {
  async signup(req, res, next) {
    try {
      const { client, owner } = await authService.signup(req.body);
      await audit({ clientId: client._id, userId: owner._id, action: 'CLIENT_SIGNUP', resource: 'Client', resourceId: client._id, ipAddress: req.ip, userAgent: req.headers['user-agent'] });
      apiResponse.success(res, { clientId: client._id, userId: owner._id }, 'Client and owner account created', 201);
    } catch (err) { next(err); }
  },

  async login(req, res, next) {
    try {
      const user = await authService.login(req.body.email, req.body.password);
      req.session.userId = String(user._id);
      // Persist before responding so a fast follow-up /auth/me sees the session.
      await new Promise((resolve, reject) => {
        req.session.save((err) => (err ? reject(err) : resolve()));
      });
      await audit({ clientId: user.clientId, userId: user._id, action: 'LOGIN', ipAddress: req.ip, userAgent: req.headers['user-agent'] });
      apiResponse.success(res, { userId: user._id, role: user.role }, 'Logged in');
    } catch (err) {
      await audit({ action: 'LOGIN_FAILED', metadata: { email: req.body?.email }, ipAddress: req.ip, userAgent: req.headers['user-agent'] });
      next(err);
    }
  },

  logout(req, res) {
    const { userId, clientId } = req.session;
    req.session.destroy(async () => {
      res.clearCookie('connect.sid');
      if (userId) await audit({ clientId, userId, action: 'LOGOUT', ipAddress: req.ip, userAgent: req.headers['user-agent'] });
      apiResponse.success(res, {}, 'Logged out');
    });
  },

  me(req, res) {
    const u = req.currentUser;
    apiResponse.success(res, {
      id: u._id,
      name: u.name,
      email: u.email,
      phone: u.phone,
      role: u.role,
      clientId: u.clientId || null,
      estateIds: u.estateIds || [],
      isActive: u.isActive,
      lastLoginAt: u.lastLoginAt,
      createdAt: u.createdAt,
    });
  },

  /** Session-based auth has no refresh token to rotate; this simply
   * extends the current session's expiry, kept for API-shape parity with
   * the requested /auth/refresh endpoint. */
  refresh(req, res) {
    req.session.touch();
    apiResponse.success(res, {}, 'Session refreshed');
  },
};