// src/middlewares/authorize.js
import { apiResponse } from '../utils/apiResponse.js';

export function authorize(...roles) {
  return (req, res, next) => {
    if (!req.currentUser) return apiResponse.error(res, 'AUTH_REQUIRED', 'Authentication required', 401);
    if (roles.length && !roles.includes(req.currentUser.role)) {
      return apiResponse.error(res, 'FORBIDDEN', 'Not permitted', 403);
    }
    next();
  };
}
