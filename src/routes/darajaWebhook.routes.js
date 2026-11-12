// src/routes/darajaWebhook.routes.js
//
// G5.3 — Public Daraja callback routes (no CSRF).
// Paths intentionally avoid prohibited keywords (mpesa, query, safaricom).

import { Router } from 'express';
import { webhookRateLimiter } from '../middlewares/rateLimiter.js';
import {
  handleC2bConfirmation,
  handleC2bValidation,
} from '../services/mpesa/darajaC2b.service.js';
import { ingestPullPayload } from '../services/mpesa/darajaPull.service.js';
import { INGESTION_SOURCE } from '../services/mpesa/daraja.constants.js';
import { env } from '../config/environment.js';
import { logger } from '../config/logger.js';

const router = Router();

function darajaCallbacksExposed() {
  if (env.DARAJA_CALLBACKS_ENABLED === '1') return true;
  if (env.NODE_ENV === 'production') return false;
  return env.DARAJA_CALLBACKS_LAB === '1';
}

router.post('/daraja/c2b/confirm', webhookRateLimiter, async (req, res) => {
  if (!darajaCallbacksExposed()) {
    return res.status(503).json({ ResultCode: 1, ResultDesc: 'Not exposed' });
  }
  try {
    const result = await handleC2bConfirmation(req.body);
    return res.status(result.httpStatus || 200).json(result.ack);
  } catch (err) {
    logger.error({ err: err.message }, 'C2B confirm handler error');
    return res.status(500).json({ ResultCode: 1, ResultDesc: 'Handler error' });
  }
});

router.post('/daraja/c2b/validate', webhookRateLimiter, async (req, res) => {
  if (!darajaCallbacksExposed()) {
    return res.status(503).json({ ResultCode: 1, ResultDesc: 'Not exposed' });
  }
  const ack = await handleC2bValidation(req.body);
  return res.status(200).json(ack);
});

router.post('/daraja/pull/results', webhookRateLimiter, async (req, res) => {
  if (!darajaCallbacksExposed()) {
    return res.status(503).json({ ResultCode: 1, ResultDesc: 'Not exposed' });
  }
  try {
    const result = await ingestPullPayload(req.body, {
      sourceChannel: INGESTION_SOURCE.PULL_CALLBACK,
    });
    if (!result.allPersisted) {
      return res.status(500).json({ ResultCode: 1, ResultDesc: 'Partial persist failure' });
    }
    return res.status(200).json({ ResultCode: 0, ResultDesc: 'Accepted' });
  } catch (err) {
    logger.error({ err: err.message }, 'Pull results handler error');
    return res.status(500).json({ ResultCode: 1, ResultDesc: 'Handler error' });
  }
});

export default router;
