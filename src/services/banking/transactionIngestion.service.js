// src/services/banking/transactionIngestion.service.js
//
// G4 Batch 03: single shared ingestion pipeline for poll and webhook.
// Does not implement sync workers or webhook routes — those call this later.

import { BankTransaction } from '../../models/BankTransaction.js';
import { BankAccount } from '../../models/BankAccount.js';
import { BankConnection } from '../../models/BankConnection.js';
import { validateNormalizedTransaction } from './normalizedTransaction.js';
import {
  claimBankTransaction,
  completeClaim,
  failClaim,
} from './processingClaim.js';
import { reconciliationService } from '../reconciliation.service.js';
import { Errors } from '../../utils/errors.js';
import { logger } from '../../config/logger.js';

function sameId(a, b) {
  return a != null && b != null && String(a) === String(b);
}

/**
 * Load and validate account + optional connection for ingestion ownership.
 */

/**
 * Resolve current persisted ownership and authorization for NEW ingestion.
 *
 * A supplied BankAccount is only a snapshot/reference. It is never the
 * authority for ownership, connection status, validation or entitlements.
 */
export async function resolveIngestionContext({
  bankAccountId = null,
  bankAccount = null,
  connectionId = null,
  ingestionChannel = null,
  expectedCredentialVersion = null,
} = {}) {
  const accountId = bankAccount?._id || bankAccountId;
  if (!accountId) throw Errors.BankAccountNotFound();

  if (
    bankAccount?._id
    && bankAccountId
    && !sameId(bankAccount._id, bankAccountId)
  ) {
    throw Errors.Conflict('Supplied bank account identifiers do not match');
  }

  const account = await BankAccount.findById(accountId);
  if (!account) throw Errors.BankAccountNotFound();

  // Reject stale snapshots after ownership, provider or connection changes.
  if (bankAccount) {
    const identityFields = ['clientId', 'estateId', 'connectionId'];
    for (const field of identityFields) {
      if (bankAccount[field] === undefined) continue;
      const oldValue = bankAccount[field];
      const currentValue = account[field];
      const equal = oldValue == null && currentValue == null
        ? true
        : sameId(oldValue, currentValue);

      if (!equal) {
        throw Errors.Conflict(`Bank account snapshot is stale (${field} changed)`);
      }
    }

    if (
      bankAccount.provider != null
      && String(bankAccount.provider).toUpperCase()
        !== String(account.provider).toUpperCase()
    ) {
      throw Errors.Conflict('Bank account snapshot is stale (provider changed)');
    }

    if (
      bankAccount.clientId != null
      && !sameId(bankAccount.clientId, account.clientId)
    ) {
      throw Errors.Conflict('Bank account snapshot belongs to another client');
    }
  }

  if (account.connectionStatus !== 'connected') {
    throw Errors.Conflict('Bank account is not connected');
  }
  if (account.validationStatus !== 'validated') {
    throw Errors.Conflict('Bank account has not completed validation');
  }
  if (!account.connectionId) {
    throw Errors.Conflict('Bank account has no current connection association');
  }

  if (connectionId != null && !sameId(connectionId, account.connectionId)) {
    throw Errors.Conflict('Requested connection is not the bank account current connection');
  }

  const channelPolicy = {
    poll: { entitlement: 'poll', sourceChannel: 'poll' },
    statement: { entitlement: 'statement', sourceChannel: 'import' },
    webhook: { entitlement: 'webhookIngest', sourceChannel: 'webhook' },
  };
  const policy = channelPolicy[ingestionChannel];

  if (!policy) {
    throw Errors.InvalidRequest('A trusted ingestionChannel is required');
  }
  if (account.entitlements?.[policy.entitlement] !== true) {
    throw Errors.Forbidden(
      `Bank account is not entitled to ${ingestionChannel} ingestion`
    );
  }

  const connection = await BankConnection.findById(account.connectionId);
  if (!connection) {
    throw Errors.NotFound('Current bank connection not found for account');
  }
  if (!sameId(connection.clientId, account.clientId)) {
    throw Errors.Conflict('Bank connection client does not match account client');
  }
  if (
    String(connection.provider).toUpperCase()
    !== String(account.provider).toUpperCase()
  ) {
    throw Errors.Conflict('Bank connection provider does not match account provider');
  }
  if (connection.status !== 'active') {
    throw Errors.BankAuthFailed('Current bank connection is not active');
  }

  if (expectedCredentialVersion != null) {
    const expectedVersion = Number(expectedCredentialVersion);
    const currentVersion = Number(connection.credentialVersion);

    if (
      !Number.isSafeInteger(expectedVersion)
      || expectedVersion < 1
      || !Number.isSafeInteger(currentVersion)
      || currentVersion !== expectedVersion
    ) {
      throw Errors.Conflict('Bank connection credentials changed during ingestion');
    }
  }

  return {
    account,
    connection,
    ingestionChannel,
    sourceChannel: policy.sourceChannel,
  };
}

/**
 * Idempotent persist matching unique index { provider, providerTransactionId }.
 * On duplicate, verifies ownership before returning the existing row.
 */

/**
 * Persist only after resolveIngestionContext has authorized the current
 * account, connection and channel. This is intentionally module-private.
 */
async function persistNormalizedTransaction(account, connection, normalized, sourceChannel) {
  const check = validateNormalizedTransaction(normalized);
  if (!check.ok) {
    const err = Errors.InvalidRequest(`Invalid normalized transaction: ${check.errors.join('; ')}`);
    err.validationErrors = check.errors;
    throw err;
  }

  const value = check.value;

  if (value.provider !== String(account.provider).toUpperCase()) {
    throw Errors.Conflict('Normalized provider does not match bank account provider');
  }
  if (!connection?._id || !sameId(connection._id, account.connectionId)) {
    throw Errors.Conflict('Ingestion connection does not match current account association');
  }
  if (!['poll', 'import', 'webhook'].includes(sourceChannel)) {
    throw Errors.InvalidRequest('Invalid trusted transaction provenance');
  }

  const filter = {
    provider: value.provider,
    providerTransactionId: value.providerTransactionId,
  };

  const assertExistingOwnership = (existing) => {
    if (
      !sameId(existing.clientId, account.clientId)
      || !sameId(existing.estateId, account.estateId)
      || !sameId(existing.bankAccountId, account._id)
    ) {
      throw Errors.Conflict(
        'Duplicate provider transaction identity belongs to a different ownership context'
      );
    }
  };

  const existing = await BankTransaction.findOne(filter);
  if (existing) {
    assertExistingOwnership(existing);
    // Preserve first-accepted connection and source provenance on duplicates.
    return { created: false, doc: existing };
  }

  try {
    const doc = await BankTransaction.create({
      clientId: account.clientId,
      estateId: account.estateId,
      bankAccountId: account._id,
      connectionId: connection._id,
      provider: value.provider,
      providerTransactionId: value.providerTransactionId,
      amountCents: value.amountCents,
      currency: value.currency,
      transactionDate: value.transactionDate,
      valueDate: value.valueDate,
      paymentReference: value.paymentReference,
      narration: value.narration,
      eventType: value.eventType,
      rawReference: value.rawReference,
      bookedBalanceCents: value.bookedBalanceCents,
      clearedBalanceCents: value.clearedBalanceCents,
      // Never accept sourceChannel from provider-normalized data.
      sourceChannel,
      schemaUnverified: value.schemaUnverified,
      rawPayload: value.rawPayload,
      processingState: 'RECEIVED',
    });

    return { created: true, doc };
  } catch (err) {
    if (err.code === 11000) {
      const raced = await BankTransaction.findOne(filter);
      if (!raced) throw err;
      assertExistingOwnership(raced);
      return { created: false, doc: raced };
    }
    throw err;
  }
}

/**
 * Claim + hand off CREDIT to existing G3 reconciliation.
 * DEBIT is not treated as a rent receipt.
 * Already POSTED / MANUAL_REVIEW / FAILED_TERMINAL are left alone.
 */

/**
 * Process an already-persisted transaction through G3.
 *
 * Deliberately does NOT resolve the current BankAccount or BankConnection:
 * connectionId is historical first-accepted provenance. Reconnect/disconnect
 * must not strand transactions already durably accepted by ingestion.
 */
export async function processBankTransaction(doc) {
  if (!doc?._id) return { processed: false, reason: 'missing' };

  const transaction = await BankTransaction.findById(doc._id);
  if (!transaction) return { processed: false, reason: 'missing' };

  const requiredOwnership = [
    'clientId',
    'estateId',
    'bankAccountId',
    'provider',
    'providerTransactionId',
  ];
  if (requiredOwnership.some((field) => transaction[field] == null || transaction[field] === '')) {
    logger.error({
      id: String(transaction._id),
    }, 'Persisted bank transaction has incomplete historical ownership');
    return {
      processed: false,
      reason: 'invalid_historical_ownership',
      doc: transaction,
    };
  }

  if (['POSTED', 'FAILED_TERMINAL', 'MANUAL_REVIEW'].includes(transaction.processingState)) {
    return { processed: false, reason: 'terminal_or_review', doc: transaction };
  }

  if (transaction.eventType !== 'CREDIT') {
    if (transaction.processingState === 'RECEIVED') {
      transaction.processingState = 'MANUAL_REVIEW';
      transaction.lastProcessingError = 'DEBIT not auto-posted as rent receipt';
      await transaction.save();
    }
    return { processed: false, reason: 'non_credit', doc: transaction };
  }

  const { claimed, doc: claimedDoc, claimToken } = await claimBankTransaction(transaction._id);
  if (!claimed) {
    return { processed: false, reason: 'not_claimed', doc: claimedDoc };
  }

  try {
    await reconciliationService.reconcile(claimedDoc, { claimToken });

    const fresh = await BankTransaction.findById(claimedDoc._id);
    if (!fresh) {
      return { processed: false, reason: 'missing_after_reconcile' };
    }

    if (fresh.processingState === 'POSTED') {
      await BankTransaction.findOneAndUpdate(
        {
          _id: fresh._id,
          processingClaimToken: claimToken,
        },
        {
          $set: {
            processingClaimToken: null,
            processingClaimExpiresAt: null,
            lastProcessingError: null,
          },
        }
      );
      const finalDoc = await BankTransaction.findById(fresh._id);
      return { processed: true, doc: finalDoc };
    }

    if (fresh.processingState === 'MANUAL_REVIEW') {
      await BankTransaction.findOneAndUpdate(
        {
          _id: fresh._id,
          processingClaimToken: claimToken,
        },
        {
          $set: {
            processingClaimToken: null,
            processingClaimExpiresAt: null,
          },
        }
      );
      const finalDoc = await BankTransaction.findById(fresh._id);
      return { processed: true, doc: finalDoc, reason: 'manual_review' };
    }

    if (fresh.processingState === 'CLAIMED') {
      await failClaim(claimedDoc._id, claimToken, {
        errorMessage: 'reconciliation did not complete',
      });
      return { processed: false, reason: 'reconcile_incomplete' };
    }

    await BankTransaction.findOneAndUpdate(
      {
        _id: fresh._id,
        processingClaimToken: claimToken,
      },
      {
        $set: {
          processingClaimToken: null,
          processingClaimExpiresAt: null,
        },
      }
    );
    const finalDoc = await BankTransaction.findById(fresh._id);
    return { processed: true, doc: finalDoc };
  } catch (err) {
    await failClaim(claimedDoc._id, claimToken, {
      errorMessage: err.message,
      terminal: false,
    });
    logger.error({
      id: String(claimedDoc._id),
      error: err.message,
    }, 'Bank transaction processing failed; left retryable');
    return { processed: false, reason: 'reconcile_error', error: err.message };
  }
}

/**
 * Full shared ingestion entry: context → validate → persist → optional process.
 *
 * @param {object} opts
 * @param {object} opts.normalized — adapter-normalized candidate
 * @param {object} [opts.bankAccount]
 * @param {string|ObjectId} [opts.bankAccountId]
 * @param {boolean} [opts.process=true] — run claim + G3 handoff for CREDIT
 */

/**
 * Full shared ingestion entry: persisted authorization → validation → persist → process.
 */
export async function ingestNormalizedTransaction({
  normalized,
  bankAccount = null,
  bankAccountId = null,
  connectionId = null,
  ingestionChannel = null,
  expectedCredentialVersion = null,
  process = true,
} = {}) {
  const context = await resolveIngestionContext({
    bankAccount,
    bankAccountId,
    connectionId,
    ingestionChannel,
    expectedCredentialVersion,
  });

  const { created, doc } = await persistNormalizedTransaction(
    context.account,
    context.connection,
    {
      ...normalized,
      provider: normalized?.provider || context.account.provider,
    },
    context.sourceChannel
  );

  let processResult = null;
  if (process) {
    processResult = await processBankTransaction(doc);
  }

  return {
    created,
    doc: processResult?.doc || doc,
    processResult,
  };
}

/**
 * Batch helper for poll/import paths.
 */

/**
 * Batch helper. Authorization channel is trusted server input; individual
 * normalized items cannot select their own persisted provenance.
 */
export async function ingestNormalizedTransactionBatch(account, items, {
  process = true,
  ingestionChannel = null,
  connectionId = account?.connectionId ?? null,
  expectedCredentialVersion = null,
} = {}) {
  let stored = 0;
  let processed = 0;
  const results = [];

  for (const item of items) {
    try {
      const outcome = await ingestNormalizedTransaction({
        bankAccount: account,
        connectionId,
        ingestionChannel,
        expectedCredentialVersion,
        normalized: item,
        process,
      });

      if (outcome.created) stored += 1;
      if (outcome.processResult?.processed) processed += 1;
      results.push({ ok: true, ...outcome });
    } catch (err) {
      logger.warn({
        clientId: String(account?.clientId),
        error: err.message,
        code: err.code,
      }, 'Skipping invalid, unauthorized or conflicting normalized transaction');

      results.push({ ok: false, error: err.message, code: err.code });
    }
  }

  return { stored, processed, results };
}

export const transactionIngestionService = {
  resolveIngestionContext,
  processBankTransaction,
  ingestNormalizedTransaction,
  ingestNormalizedTransactionBatch,
};
