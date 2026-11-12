// src/jobs/bankSync.job.js
// Scheduled sync shares bankSyncService coordination with manual sync.

import { BankAccount } from '../models/BankAccount.js';
import { bankSyncService } from '../services/banking/bankSync.service.js';
import { logger } from '../config/logger.js';

export async function bankSyncJob() {
  const accounts = await BankAccount.find({
    connectionStatus: 'connected',
    $or: [
      { 'entitlements.statement': true },
      { 'entitlements.poll': true },
    ],
  });

  for (const account of accounts) {
    try {
      const result = await bankSyncService.synchronizeBankAccount(
        account.clientId,
        account._id
      );
      logger.info({
        clientId: String(account.clientId),
        estateId: String(account.estateId),
        bankAccountId: String(account._id),
        ...result,
      }, 'Bank sync complete');
    } catch (err) {
      logger.error({
        clientId: String(account.clientId),
        bankAccountId: String(account._id),
        error: err.message,
        code: err.code,
      }, 'Bank sync failed');
    }
  }
}
