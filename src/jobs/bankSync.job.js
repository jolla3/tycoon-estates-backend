// src/jobs/bankSync.job.js
// Scheduled sync shares bankSyncService coordination with manual sync.

import { BankAccount } from '../models/BankAccount.js';
import { bankSyncService } from '../services/banking/bankSync.service.js';
import { checkEntitlement } from '../services/entitlement.service.js';
import { logger } from '../config/logger.js';

export async function bankSyncJob() {
  const accounts = await BankAccount.find({
    connectionStatus: 'connected',
    $or: [
      { 'entitlements.statement': true },
      { 'entitlements.poll': true },
    ],
  });

  const summary = { attempted: 0, successful: 0, failed: 0, blocked: 0, skipped: 0 };
  const perClient = new Map();
  const tally = (cid, k) => {
    const e = perClient.get(cid) || { clientId: cid, attempted: 0, successful: 0, failed: 0, blocked: 0 };
    e[k] += 1;
    perClient.set(cid, e);
  };
  const entitlementCache = new Map();

  for (const account of accounts) {
    // Superadmin V2: active Client + explicit BANKING required before any sync work.
    const key = String(account.clientId);
    if (!entitlementCache.has(key)) {
      entitlementCache.set(key, await checkEntitlement(account.clientId, 'BANKING'));
    }
    const gate = entitlementCache.get(key);
    if (!gate.entitled) {
      summary.blocked += 1;
      tally(key, 'blocked');
      logger.info({ clientId: key, bankAccountId: String(account._id), reason: gate.reason },
        'Bank sync skipped — client not entitled to BANKING');
      continue;
    }
    summary.attempted += 1;
    tally(key, 'attempted');
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
      summary.successful += 1;
      tally(key, 'successful');
    } catch (err) {
      logger.error({
        clientId: String(account.clientId),
        bankAccountId: String(account._id),
        error: err.message,
        code: err.code,
      }, 'Bank sync failed');
      summary.failed += 1;
      tally(key, 'failed');
    }
  }
  return { ...summary, clients: [...perClient.values()] };
}
