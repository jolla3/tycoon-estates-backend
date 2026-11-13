// src/routes/mpesaPublic.routes.js — UNAUTHENTICATED Tenant SMS submission (bearer token in body).
// Mounted in app.js BEFORE the global JSON parser, session, cookie and CSRF layers:
// no cookie/CSRF dependency, own tiny body limit, uniform neutral responses.
import express, { Router } from 'express';
import { publicSubmissionGuard } from '../middlewares/publicSubmissionGuard.js';
import { submitSms } from '../services/mpesa/mpesaSubmission.service.js';
import { logger } from '../config/logger.js';

const router = Router();
router.use(publicSubmissionGuard);
router.use(express.json({ limit: '4kb', type: 'application/json' }));

// Body-parser errors (oversized/invalid JSON) -> same neutral shape, no detail.
router.post('/submissions', async (req, res) => {
  const { token, text, ...rest } = req.body || {};
  if (Object.keys(rest).length) return res.status(400).json({ success: false, error: { code: 'INVALID_REQUEST', message: 'Request could not be processed' } });
  try {
    const out = await submitSms({ token, text });
    if (!out.accepted) return res.status(404).json({ success: false, error: { code: 'NOT_FOUND', message: 'Link not available' } });
    return res.status(202).json({ success: true, data: { received: true } });
  } catch (err) {
    logger.error({ code: err.code }, 'public submission failure'); // never log token/text
    return res.status(503).json({ success: false, error: { code: 'UNAVAILABLE', message: 'Please try again later' } });
  }
});

router.use((err, _req, res, _next) => {
  const status = err.type === 'entity.too.large' ? 413 : 400;
  res.status(status).json({ success: false, error: { code: 'INVALID_REQUEST', message: 'Request could not be processed' } });
});

export default router;
