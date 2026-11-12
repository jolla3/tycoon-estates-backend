// src/services/bank.service.js
//
// Bank account onboarding, listing, and (existing) sync/statement entry points.
// G4 Batch 02: connection association, physical identity reuse, fail-closed validation.
// Transaction ingestion/sync behaviour is not redesigned in this batch.

import { BankAccount } from '../models/BankAccount.js';
import { Estate } from '../models/Estate.js';
import { BankConnection } from '../models/BankConnection.js';
import {
  assertProviderOperational,
  getBankProviderCapabilities,
} from './banking/bank.factory.js';
import { connectionService } from './connection.service.js';
import { encryptionUtil } from '../utils/encryption.js';
import { ingestNormalizedTransactionBatch } from './banking/transactionIngestion.service.js';
import { bankSyncService } from './banking/bankSync.service.js';
import { Errors, AppError } from '../utils/errors.js';
import { logger } from '../config/logger.js';
import { audit } from './audit.service.js';
import { estateFilterClause } from '../utils/estateFilter.js';

function toPublicBankAccount(account) {
  if (!account) return null;
  const a = typeof account.toObject === 'function' ? account.toObject() : account;
  return {
    id: a._id,
    estateId: a.estateId,
    connectionId: a.connectionId || null,
    provider: a.provider,
    accountName: a.accountName,
    currency: a.currency || 'KES',
    connectionStatus: a.connectionStatus,
    validationStatus: a.validationStatus || 'pending',
    lastValidatedAt: a.lastValidatedAt || null,
    entitlements: a.entitlements || {
      poll: false,
      statement: false,
      balance: false,
      webhookIngest: false,
    },
    lastSyncedAt: a.lastSyncedAt || null,
    createdAt: a.createdAt,
    updatedAt: a.updatedAt,
    accountNumberMasked: null,
  };
}

function entitlementsFromCapabilities(caps) {
  return {
    poll: Boolean(caps?.polling),
    statement: Boolean(caps?.statementImport),
    balance: Boolean(caps?.balance),
    webhookIngest: Boolean(caps?.webhook),
  };
}

async function storeAndReconcile(clientId, estateId, bankAccountId, normalizedTxns) {
  const account = await BankAccount.findById(bankAccountId);
  if (!account || String(account.clientId) !== String(clientId)) {
    throw Errors.BankAccountNotFound();
  }
  const { stored, processed } = await ingestNormalizedTransactionBatch(
    account,
    normalizedTxns,
    {
      process: true,
      ingestionChannel: 'statement',
      connectionId: account.connectionId,
    }
  );
  return { stored, reconciled: processed };
}

async function requireActiveConnection(clientId, connectionId, expectedProvider = null) {
  const connection = await BankConnection.findOne({ _id: connectionId, clientId });
  if (!connection) throw Errors.NotFound('Bank connection not found');
  if (connection.status === 'disconnected') {
    throw Errors.Conflict('Bank connection is disconnected');
  }
  if (connection.status !== 'active') {
    throw Errors.BankAuthFailed(
      `Bank connection is not active (status=${connection.status})`
    );
  }
  if (expectedProvider && connection.provider !== String(expectedProvider).toUpperCase()) {
    throw Errors.InvalidRequest('Bank connection provider does not match account provider');
  }
  return connection;
}

export const bankService = {
  /**
   * Link / reconnect a physical bank account under a client-owned connection.
   * Same client + provider + accountNumberHash → reuse existing BankAccount _id.
   * Different client owning the same physical account → conflict.
   * Validation failure → not activated (fail closed).
   */
  async connectAccount(clientId, estateId, {
    provider,
    accountNumber,
    accountName,
    currency,
    connectionId,
    allowEstateReassignment = false,
  }) {
    if (!connectionId) {
      throw Errors.InvalidRequest('connectionId is required to link a bank account');
    }

    assertProviderOperational(provider, { allowLab: true });
    const providerKey = String(provider).toUpperCase();

    const estate = await Estate.findOne({ _id: estateId, clientId });
    if (!estate) throw Errors.EstateNotFound('Estate not found for your client');

    const connection = await requireActiveConnection(clientId, connectionId, providerKey);
    const caps = getBankProviderCapabilities(providerKey);
    const accountNumberHash = encryptionUtil.hashForLookup(accountNumber);

    // Read the existing physical-account owner. Do not mutate this document.
    const existingAccount = await BankAccount.findOne({
      provider: providerKey,
      accountNumberHash,
    });

    if (
      existingAccount
      && String(existingAccount.clientId) !== String(clientId)
    ) {
      throw Errors.Conflict(
        'This bank account is already registered to a different Tycoon client'
      );
    }

    const reused = Boolean(existingAccount);
    const previousEstateId = existingAccount?.estateId ?? null;
    const estateReassigned = Boolean(
      existingAccount
      && String(existingAccount.estateId) !== String(estateId)
    );

    if (estateReassigned && !allowEstateReassignment) {
      throw Errors.Conflict(
        'Physical bank account is linked to a different estate. Pass allowEstateReassignment=true to reassign explicitly.'
      );
    }

    const encryptedAccountNumber = encryptionUtil.encrypt(accountNumber);
    const proposedAccountName = accountName || existingAccount?.accountName;
    const proposedCurrency = currency || existingAccount?.currency || 'KES';

    // Build a detached validation candidate. The live BankAccount document
    // remains untouched until provider validation has succeeded.
    const validationCandidate = new BankAccount({
      ...(existingAccount
        ? (typeof existingAccount.toObject === 'function'
          ? existingAccount.toObject()
          : { ...existingAccount })
        : {}),
      clientId,
      estateId,
      connectionId: connection._id,
      provider: providerKey,
      accountNumberEncrypted: encryptedAccountNumber,
      accountNumberHash,
      accountName: proposedAccountName,
      currency: proposedCurrency,
      connectionStatus: 'pending',
      validationStatus: 'pending',
      lastValidatedAt: null,
      entitlements: {
        poll: false,
        statement: false,
        balance: false,
        webhookIngest: false,
      },
    });

    // Authenticate and validate the detached candidate before any account write.
    try {
      const adapter = await connectionService.getAdapterForConnection(connection);
      await adapter.authenticate();

      if (typeof adapter.validateAccount !== 'function') {
        throw Errors.BankAuthFailed(
          'Account validation is not available for this provider'
        );
      }

      try {
        await adapter.validateAccount(validationCandidate);
      } catch (validationErr) {
        logger.warn({
          clientId: String(clientId),
          connectionId: String(connection._id),
          error: validationErr.message,
        }, 'Account validation failed; existing account association was retained');

        throw Errors.InvalidRequest(
          `Account validation failed: ${validationErr.message || 'rejected by provider'}`
        );
      }
    } catch (err) {
      logger.error({
        clientId: String(clientId),
        connectionId: String(connection._id),
        provider: providerKey,
        reused,
        error: err.message,
      }, 'Bank account validation failed; no account changes were committed');
      throw err;
    }

    const validatedAt = new Date();
    const accountUpdates = {
      estateId,
      connectionId: connection._id,
      accountName: proposedAccountName,
      currency: proposedCurrency,
      accountNumberEncrypted: encryptedAccountNumber,
      accountNumberHash,
      connectionStatus: 'connected',
      validationStatus: 'validated',
      lastValidatedAt: validatedAt,
      entitlements: entitlementsFromCapabilities(caps),
    };

    let bankAccount;

    if (existingAccount) {
      // Compare-and-set prevents a stale validation result from overwriting
      // a concurrent reconnect, disconnect or estate reassignment.
      if (
        !(existingAccount.updatedAt instanceof Date)
        || Number.isNaN(existingAccount.updatedAt.getTime())
      ) {
        throw Errors.Conflict(
          'Existing bank account has no reliable update version; refusing unsafe reconnect'
        );
      }

      const filter = {
        _id: existingAccount._id,
        clientId,
        provider: providerKey,
        accountNumberHash,
        estateId: existingAccount.estateId,
        connectionId: existingAccount.connectionId ?? null,
        connectionStatus: existingAccount.connectionStatus,
        validationStatus: existingAccount.validationStatus,
        updatedAt: existingAccount.updatedAt,
      };

      try {
        bankAccount = await BankAccount.findOneAndUpdate(
          filter,
          { $set: accountUpdates },
          { new: true, runValidators: true }
        );
      } catch (err) {
        logger.error({
          clientId: String(clientId),
          bankAccountId: String(existingAccount._id),
          connectionId: String(connection._id),
          error: err.message,
        }, 'Bank account reconnect persistence outcome is uncertain');

        throw Errors.Conflict(
          'Bank account reconnect outcome is uncertain; reload the account before retrying'
        );
      }

      if (!bankAccount) {
        throw Errors.Conflict(
          'Bank account changed during provider validation; reload it and retry the reconnect'
        );
      }
    } else {
      try {
        bankAccount = await BankAccount.create({
          clientId,
          provider: providerKey,
          ...accountUpdates,
        });
      } catch (err) {
        if (err.code === 11000) {
          throw Errors.Conflict(
            'This physical bank account was linked concurrently; reload the account before retrying'
          );
        }
        throw err;
      }
    }

    // Audits describe committed state only. No reassignment audit is emitted
    // for a rejected validation or failed compare-and-set.
    await audit({
      clientId,
      estateId,
      action: 'BANK_ACCOUNT_CONNECTED',
      resource: 'BankAccount',
      resourceId: bankAccount._id,
      metadata: {
        provider: providerKey,
        connectionId: String(connection._id),
        validationStatus: bankAccount.validationStatus,
        reused,
      },
    });

    if (estateReassigned) {
      await audit({
        clientId,
        estateId,
        action: 'BANK_ACCOUNT_ESTATE_REASSIGNED',
        resource: 'BankAccount',
        resourceId: bankAccount._id,
        metadata: {
          previousEstateId: String(previousEstateId),
          newEstateId: String(estateId),
          connectionId: String(connection._id),
          provider: providerKey,
        },
      });
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
    return account;
  },

  async getPublic(clientId, bankAccountId, estateFilter = null) {
    return toPublicBankAccount(await this.get(clientId, bankAccountId, estateFilter));
  },

  async sync(clientId, bankAccountId, estateFilter = null) {
    // estateFilter still enforced via get for authorization
    await this.get(clientId, bankAccountId, estateFilter);
    return bankSyncService.synchronizeBankAccount(clientId, bankAccountId);
  },

  async importStatement(clientId, bankAccountId, startDate, endDate, estateFilter = null) {
    const bankAccount = await this.get(clientId, bankAccountId, estateFilter);
    if (bankAccount.connectionStatus !== 'connected') {
      throw Errors.Conflict('Bank account is not connected');
    }
    if (!bankAccount.connectionId) {
      throw Errors.Conflict('Bank account has no connection association (legacy record requires explicit migration)');
    }
    if (!bankAccount.entitlements?.statement) {
      throw Errors.Forbidden('Account is not entitled to statement import');
    }
    const connection = await requireActiveConnection(
      clientId,
      bankAccount.connectionId,
      bankAccount.provider
    );
    const provider = await connectionService.getAdapterForConnection(connection);
    const normalized = await provider.getFullStatement(bankAccount, startDate, endDate);
    return storeAndReconcile(clientId, bankAccount.estateId, bankAccount._id, normalized);
  },
};
