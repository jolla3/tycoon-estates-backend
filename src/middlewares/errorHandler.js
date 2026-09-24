// src/middlewares/errorHandler.js — centralized error handling (section 28).
import { AppError } from '../utils/errors.js';
import { apiResponse } from '../utils/apiResponse.js';
import { logger } from '../config/logger.js';
import { isProduction } from '../config/environment.js';

// eslint-disable-next-line no-unused-vars
export function errorHandler(err, req, res, _next) {
  if (err instanceof AppError) {
    return apiResponse.error(res, err.code, err.message, err.status);
  }

  logger.error({ error: err.message, stack: isProduction ? undefined : err.stack, path: req.path }, 'Unhandled error');
  return apiResponse.error(res, 'INTERNAL_ERROR', 'Something went wrong', 500);
}

export function notFoundHandler(req, res) {
  return apiResponse.error(res, 'NOT_FOUND', `No route for ${req.method} ${req.path}`, 404);
}
