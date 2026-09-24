// src/middlewares/authenticate.js
//
// Section 4/26: session-backed cookie auth (see app.js for the
// express-session + connect-mongo setup — shared store, so any API
// instance behind the load balancer can serve the request).

import { User } from '../models/User.js';
import { apiResponse } from '../utils/apiResponse.js';

export async function authenticate(req, res, next) {
  if (!req.session || !req.session.userId) {
    return apiResponse.error(res, 'AUTH_REQUIRED', 'Authentication required', 401);
  }
  try {
    const user = await User.findById(req.session.userId);
    if (!user || !user.isActive) {
      return apiResponse.error(res, 'AUTH_REQUIRED', 'Session user no longer exists or is inactive', 401);
    }
    req.currentUser = user;
    next();
  } catch (err) {
    next(err);
  }
}
