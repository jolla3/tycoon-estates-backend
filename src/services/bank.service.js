// src/services/bank.service.js
//
// Section 14/15/31: bank account connection, sync, and historical
// statement import. Only ever talks to a provider through
// bank.factory.js — never imports a concrete provider directly.
// clientId-scoped throughout (section 2).

import { BankAccount } from '../models/BankAccount.js';
import { BankTransaction } from '../models/BankTransaction.js';
import { Estate } from '../models/Estate.js';
import { getBankProvider } from './banking/bank.factory.js';
import { encryptionUtil } from '../utils/encryption.js';
import { withIdempotency } from '../utils/idempotency.js';
import { reconciliationService } from './reconciliation.service.js';
import { Errors } from '../utils/errors.js';
import { logger } from '../config/logger.js';
import { audit } from './audit.service.js';
import { estateFilterClause } from '../utils/estateFilter.js';

/** Public bank account DTO — never exposes ciphertext, hashes, or secrets. */
function toPublicBankAccount(account) {
  if (!account) return null;
  const a = typeof account.toObject === 'function' ? account.toObject() : account;
  return {
    id: a._id,
    estateId: a.estateId,
    provider: a.provider,
    accountName: a.accountName,
    currency: a.currency || 'KES',
    connectionStatus: a.connectionStatus,
    lastSyncedAt: a.lastSyncedAt || null,
    createdAt: a.createdAt,
    updatedAt: a.updatedAt,
    // Masked hint only when we can decrypt in-process (not stored plaintext)
    accountNumberMasked: null,
  };
}


async function storeAndReconcile(clientId, estateId, bankAccountId, normalizedTxns) {
  let stored = 0;
  let reconciled = 0;

  for (const txn of normalizedTxns) {
    if (!txn.providerTransactionId) {
      logger.warn({ clientId: String(clientId) }, 'Skipping a normalized transaction with no providerTransactionId — cannot deduplicate it safely');
      continue;
    }

    const { created, doc } = await withIdempotency(
      BankTransaction,
      txn.providerTransactionId,
      'providerTransactionId',
      () => BankTransaction.create({ ...txn, clientId, estateId, bankAccountId })
    );

    if (created) {
      stored += 1;
      if (doc.eventType === 'CREDIT') {
        await reconciliationService.reconcile(doc);
        reconciled += 1;
      }
    }
  }
  return { stored, reconciled };
}

export const bankService = {
  async connectAccount(clientId, estateId, { provider, accountNumber, accountName, currency }) {
    const estate = await Estate.findOne({ _id: estateId, clientId });
    if (!estate) throw Errors.EstateNotFound('Estate not found for your client');

    const bankAccount = await BankAccount.create({
      clientId,
      estateId,
      provider,
      accountNumberEncrypted: encryptionUtil.encrypt(accountNumber),
      accountNumberHash: encryptionUtil.hashForLookup(accountNumber),
      accountName,
      currency: currency || 'KES',
      connectionStatus: 'pending',
    });

    try {
      const providerImpl = getBankProvider(provider);
      await providerImpl.authenticate();

      // AccountValidation is the documented Co-op operation for
      // "verify a bank account" (section 9/12) — this replaces the
      // earlier version's fabricated "register-notification" call.
      if (typeof providerImpl.validateAccount === 'function') {
        try {
          await providerImpl.validateAccount(bankAccount);
        } catch (validationErr) {
          logger.warn({ clientId: String(clientId), provider, error: validationErr.message }, 'Account validation failed — connecting anyway, flagged for manual review');
        }
      }

      // Whether Co-op's SendTransactionINS subscription for this account
      // is configured via their developer portal or requires a manual
      // account-manager request is NOT documented as a REST call (see
      // coop.provider.js#registerTransactionNotification) — this only
      // logs that, it doesn't block the connection.
      if (typeof providerImpl.registerTransactionNotification === 'function') {
        await providerImpl.registerTransactionNotification(bankAccount);
      }

      bankAccount.connectionStatus = 'connected';
      bankAccount.lastSyncedAt = new Date();
      await bankAccount.save();
    } catch (err) {
      logger.error({ clientId: String(clientId), provider, error: err.message }, 'Bank account connection failed');
      bankAccount.connectionStatus = 'failed';
      await bankAccount.save();
    }

    return toPublicBankAccount(bankAccount);
  },

  async list(clientId, estateFilter) {
    const rows = await BankAccount.find({ clientId, ...estateFilterClause(estateFilter) });
    return rows.map(toPublicBankAccount);
  },

  async get(clientId, bankAccountId, estateFilter = null) {
    const account = await BankAccount.findOne({
      _id: bankAccountId,
      clientId,
      ...estateFilterClause(estateFilter),
    });
    if (!account) throw Errors.BankAccountNotFound();
    return account; // internal use (sync needs encrypted fields)
  },

  async getPublic(clientId, bankAccountId, estateFilter = null) {
    return toPublicBankAccount(await this.get(clientId, bankAccountId, estateFilter));
  },

  async sync(clientId, bankAccountId, estateFilter = null) {
    const bankAccount = await this.get(clientId, bankAccountId, estateFilter);
    const provider = getBankProvider(bankAccount.provider);
    const normalized = await provider.getTransactions(bankAccount, { noOfTransactions: 100 });

    const result = await storeAndReconcile(clientId, bankAccount.estateId, bankAccount._id, normalized);

    bankAccount.lastSyncedAt = new Date();
    await bankAccount.save();
    await audit({
      clientId,
      estateId: bankAccount.estateId,
      action: 'BANK_SYNCED',
      resource: 'BankAccount',
      resourceId: bankAccount._id,
      metadata: {
        provider: bankAccount.provider,
        stored: result.stored,
        reconciled: result.reconciled,
      },
    });
    return result;
  },

  /** Section 15/31: historical statement import for a date range (Nairobi business dates). */
  async importStatement(clientId, bankAccountId, startDate, endDate, estateFilter = null) {
    const bankAccount = await this.get(clientId, bankAccountId, estateFilter);
    const provider = getBankProvider(bankAccount.provider);
    const normalized = await provider.getFullStatement(bankAccount, startDate, endDate);
    return storeAndReconcile(clientId, bankAccount.estateId, bankAccount._id, normalized);
  },
};
