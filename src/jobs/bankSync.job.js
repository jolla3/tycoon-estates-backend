// src/jobs/bankSync.job.js — section 14/25/31. Idempotent (bank.service.js
// dedupes by providerTransactionId), so a restart mid-sync never
// double-processes a transaction, and safe under the scheduler's
// distributed lock for multi-instance deployments.
import { BankAccount } from '../models/BankAccount.js';
import { bankService } from '../services/bank.service.js';
import { logger } from '../config/logger.js';

export async function bankSyncJob() {
  const accounts = await BankAccount.find({ connectionStatus: 'connected' });
  for (const account of accounts) {
    try {
      const result = await bankService.sync(account.clientId, account._id);
      logger.info({ clientId: String(account.clientId), estateId: String(account.estateId), ...result }, 'Bank sync complete');
    } catch (err) {
      logger.error({ clientId: String(account.clientId), error: err.message }, 'Bank sync failed');
    }
  }
}
