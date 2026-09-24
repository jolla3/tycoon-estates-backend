// src/middlewares/requestLogger.js
import crypto from 'crypto';
import { logger } from '../config/logger.js';

export function requestLogger(req, res, next) {
  req.requestId = req.headers['x-request-id'] || crypto.randomUUID();
  res.setHeader('X-Request-Id', req.requestId);

  const start = Date.now();
  res.on('finish', () => {
    logger.info(
      { requestId: req.requestId, method: req.method, path: req.path, status: res.statusCode, ms: Date.now() - start },
      'request'
    );
  });
  next();
}
