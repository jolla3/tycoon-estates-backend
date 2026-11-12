// src/routes/webhook.routes.js
//
// Co-op inbound callback (SendTransactionINS).
//
// INS credential scope (Correction 3 / contract evidence):
// Co-op documents "Basic Auth Endpoint Credential" as an integration/endpoint
// credential for the callback channel — not as per-customer outbound OAuth
// material. This route therefore verifies against the platform-configured
// COOP_INS_BASIC_SECRET (application-level), NOT BankConnection outbound secrets.
// Account ownership is still resolved per payload AccountNumber → BankAccount.
//
// Exposure gate (Correction 4): production-style exposure requires operational
// readiness OR explicit COOP_WEBHOOK_LAB_OVERRIDE=1 (default off).

import { Router } from 'express';
import { BankAccount } from '../models/BankAccount.js';
import {
  getBankProviderCapabilities,
  getProviderReadiness,
  isNonProductionLabOverrideEnabled,
} from '../services/banking/bank.factory.js';
import { extractAccountNumber } from '../services/banking/providers/coop/coop.mapper.js';
import { ingestNormalizedTransaction } from '../services/banking/transactionIngestion.service.js';
import { quarantineCallbackEvent } from '../services/banking/callbackQuarantine.service.js';
import { encryptionUtil } from '../utils/encryption.js';
import { webhookRateLimiter } from '../middlewares/rateLimiter.js';
import { logger } from '../config/logger.js';
import { env } from '../config/environment.js';

const router = Router();

function coopWebhookExposureAllowed() {
  const caps = getBankProviderCapabilities('COOP');
  const readiness = getProviderReadiness('COOP');
  const webhookCap = readiness?.capabilities?.webhook;
  const operational = Boolean(
    caps?.implemented
    && webhookCap?.operationalReady
  );
  const lab = isNonProductionLabOverrideEnabled(env.COOP_WEBHOOK_LAB_OVERRIDE);
  return { allowed: operational || lab, operational, lab };
}

async function tryQuarantine(fields) {
  try {
    const doc = await quarantineCallbackEvent(fields);
    return { ok: true, id: doc._id };
  } catch (err) {
    logger.error({ error: err.message, category: fields.category }, 'Failed to quarantine callback event');
    return { ok: false, error: err.message };
  }
}

router.post('/banks/coop/transactions', webhookRateLimiter, async (req, res) => {
  const providerName = 'COOP';
  const exposure = coopWebhookExposureAllowed();
  if (!exposure.allowed) {
    return res.status(503).json({
      received: false,
      reason: 'webhook_not_exposed',
      detail: 'Co-op webhook is not operationally ready; set COOP_WEBHOOK_LAB_OVERRIDE=1 for controlled lab access',
    });
  }

  let verifyProvider;
  try {
    const { CoopBankProvider } = await import('../services/banking/providers/coop/coop.provider.js');
    // Application-level INS Basic credential (not connection outbound OAuth secrets).
    verifyProvider = new CoopBankProvider({
      insBasicSecret: env.COOP_INS_BASIC_SECRET,
    });
  } catch (err) {
    return res.status(503).json({ received: false, reason: 'provider_unavailable' });
  }

  if (!verifyProvider.verifyWebhookSignature(req)) {
    logger.warn({ ip: req.ip }, 'Rejected Co-op webhook with invalid verification');
    return res.status(401).json({ received: false });
  }

  const accountNumber = extractAccountNumber(req.body);
  if (!accountNumber) {
    const q = await tryQuarantine({
      provider: providerName,
      category: 'malformed_payload',
      reason: 'account_number_not_found_in_payload',
      body: req.body,
    });
    if (!q.ok) return res.status(500).json({ received: false, reason: 'quarantine_failed' });
    return res.status(200).json({ received: true, quarantined: true, reason: 'account_number_not_found_in_payload' });
  }

  const bankAccount = await BankAccount.findOne({
    provider: providerName,
    connectionStatus: 'connected',
    accountNumberHash: encryptionUtil.hashForLookup(accountNumber),
  });

  if (!bankAccount) {
    const q = await tryQuarantine({
      provider: providerName,
      category: 'unknown_account',
      reason: 'no_matching_connected_bank_account',
      body: req.body,
    });
    if (!q.ok) return res.status(500).json({ received: false, reason: 'quarantine_failed' });
    return res.status(200).json({ received: true, quarantined: true, reason: 'unknown_account' });
  }

  if (!bankAccount.entitlements?.webhookIngest) {
    const q = await tryQuarantine({
      provider: providerName,
      category: 'provider_capability',
      reason: 'account_not_entitled_for_webhook_ingest',
      body: req.body,
      clientId: bankAccount.clientId,
      estateId: bankAccount.estateId,
      bankAccountId: bankAccount._id,
      connectionId: bankAccount.connectionId,
    });
    if (!q.ok) return res.status(500).json({ received: false, reason: 'quarantine_failed' });
    return res.status(200).json({ received: true, quarantined: true, reason: 'not_entitled' });
  }

  let normalized;
  try {
    normalized = verifyProvider.normalizeTransaction(req.body);
  } catch (err) {
    const q = await tryQuarantine({
      provider: providerName,
      category: 'malformed_payload',
      reason: err.message || 'normalize_failed',
      body: req.body,
      clientId: bankAccount.clientId,
      bankAccountId: bankAccount._id,
      connectionId: bankAccount.connectionId,
    });
    if (!q.ok) return res.status(500).json({ received: false, reason: 'quarantine_failed' });
    return res.status(200).json({ received: true, quarantined: true, reason: 'normalize_failed' });
  }

  try {
    const outcome = await ingestNormalizedTransaction({
      bankAccount,
      normalized: {
        ...normalized,
        provider: providerName,
      },
      ingestionChannel: 'webhook',
      connectionId: bankAccount.connectionId,
      process: true,
    });

    return res.status(200).json({
      received: true,
      alreadyProcessed: !outcome.created,
      processingState: outcome.doc?.processingState,
      quarantined: false,
      labMode: exposure.lab && !exposure.operational,
    });
  } catch (err) {
    const category = err.code === 'CONFLICT'
      ? 'ownership_conflict'
      : err.code === 'INVALID_REQUEST'
        ? (String(err.message || '').includes('direction') || String(err.message || '').includes('eventType')
          ? 'invalid_direction'
          : 'validation_failed')
        : 'ingestion_error';

    const q = await tryQuarantine({
      provider: providerName,
      category,
      reason: err.message || 'ingestion_failed',
      body: req.body,
      clientId: bankAccount.clientId,
      estateId: bankAccount.estateId,
      bankAccountId: bankAccount._id,
      connectionId: bankAccount.connectionId,
      providerTransactionId: normalized?.providerTransactionId,
    });

    if (!q.ok) {
      return res.status(500).json({ received: false, reason: 'ingest_and_quarantine_failed' });
    }

    return res.status(200).json({
      received: true,
      quarantined: true,
      reason: category,
    });
  }
});

export default router;
