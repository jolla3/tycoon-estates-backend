// src/routes/webhook.routes.js
//
// Section 16: separated from authenticated frontend routes — the bank
// calls these, not the frontend. Kept intentionally lightweight
// (validate -> normalize -> idempotency check -> persist -> reconcile) so
// processing can later move behind a queue without changing this
// contract.

import { Router } from 'express';
import { BankAccount } from '../models/BankAccount.js';
import { BankTransaction } from '../models/BankTransaction.js';
import { getBankProvider } from '../services/banking/bank.factory.js';
import { extractAccountNumber } from '../services/banking/providers/coop/coop.mapper.js';
import { reconciliationService } from '../services/reconciliation.service.js';
import { withIdempotency } from '../utils/idempotency.js';
import { encryptionUtil } from '../utils/encryption.js';
import { webhookRateLimiter } from '../middlewares/rateLimiter.js';
import { logger } from '../config/logger.js';

const router = Router();

router.post('/banks/coop/transactions', webhookRateLimiter, async (req, res) => {
  try {
    const provider = getBankProvider('COOP');

    if (!provider.verifyWebhookSignature(req)) {
      logger.warn({ ip: req.ip }, 'Rejected Co-op webhook with invalid signature');
      return res.status(401).json({ received: false });
    }

    // Resolve the SPECIFIC client/account this payload belongs to — never
    // assume "the one connected Co-op account". A payment for Client B's
    // account must never be applied against Client A's houses just
    // because Client A happened to connect first (this was V1's bug).
    // AccountNumber is CONFIRMED per the supplied SendTransactionINS docs
    // (14-char posting account number) — not a guess.
    const accountNumber = extractAccountNumber(req.body);
    if (!accountNumber) {
      logger.error({ payloadKeys: Object.keys(req.body || {}) }, 'Co-op webhook payload has no AccountNumber field');
      return res.status(422).json({ received: false, reason: 'account_number_not_found_in_payload' });
    }

    const bankAccount = await BankAccount.findOne({
      provider: 'COOP',
      connectionStatus: 'connected',
      accountNumberHash: encryptionUtil.hashForLookup(accountNumber),
    });

    if (!bankAccount) {
      logger.warn({ ip: req.ip }, 'Co-op webhook for an account number with no matching connected BankAccount');
      return res.status(200).json({ received: true, note: 'no matching bank account' });
    }

    const normalized = provider.normalizeTransaction(req.body);

    const { created, doc } = await withIdempotency(
      BankTransaction,
      normalized.providerTransactionId,
      'providerTransactionId',
      () => BankTransaction.create({ ...normalized, clientId: bankAccount.clientId, estateId: bankAccount.estateId, bankAccountId: bankAccount._id })
    );

    if (created && doc.eventType === 'CREDIT') {
      await reconciliationService.reconcile(doc);
    }

    res.status(200).json({ received: true, alreadyProcessed: !created });
  } catch (err) {
    logger.error({ error: err.message }, 'Co-op webhook processing failed');
    // 500 (not 200) here so Co-op's retry mechanism re-delivers a
    // transaction we genuinely failed to store — see README "Webhook
    // acknowledgement contract".
    res.status(500).json({ received: false });
  }
});

export default router;
