import { env } from '../../config/environment.js';
// src/services/banking/bankSync.service.js
//
// Shared manual + scheduled synchronization orchestration with fencing.

import { BankAccount } from '../../models/BankAccount.js';
import { connectionService } from '../connection.service.js';
import { createCoopSyncStrategy } from './providers/coop/coop.syncStrategy.js';
import {
  acquireSyncLease,
  advanceCheckpoint,
  failSyncLease,
  releaseSyncLease,
  extendSyncLease,
  newSyncWorkerId,
} from './syncCoordination.service.js';
import { ingestNormalizedTransactionBatch } from './transactionIngestion.service.js';
import { getBankProviderCapabilities } from './bank.factory.js';
import { Errors } from '../../utils/errors.js';
import { logger } from '../../config/logger.js';
import { audit } from '../audit.service.js';

function strategyForProvider(provider) {
  const key = String(provider || '').toUpperCase();
  if (key === 'COOP') return createCoopSyncStrategy();
  // KCB / EQUITY / NCBA: no verified sync contract — explicit failure, not empty success.
  throw Errors.BankCapabilityUnsupported(
    `No operational sync strategy for provider ${provider} (contract unverified)`
  );
}


function sameId(a, b) {
  return a != null && b != null && String(a) === String(b);
}

/**
 * Recheck live sync authority at page boundaries.
 * The provider adapter is tied to one connection + credential generation.
 */
async function assertCurrentSyncContext({
  clientId,
  originalAccount,
  expectedConnectionId,
  expectedCredentialVersion,
  adapter,
}) {
  const currentAccount = await BankAccount.findOne({
    _id: originalAccount._id,
    clientId,
  });

  if (!currentAccount) throw Errors.BankAccountNotFound();

  if (
    !sameId(currentAccount.clientId, originalAccount.clientId)
    || !sameId(currentAccount.estateId, originalAccount.estateId)
    || String(currentAccount.provider).toUpperCase()
      !== String(originalAccount.provider).toUpperCase()
  ) {
    throw Errors.Conflict('Bank account ownership or provider changed during synchronization');
  }

  if (!sameId(currentAccount.connectionId, expectedConnectionId)) {
    throw Errors.Conflict('Bank account connection association changed during synchronization');
  }

  if (currentAccount.connectionStatus !== 'connected') {
    throw Errors.Conflict('Bank account was disconnected during synchronization');
  }
  if (currentAccount.validationStatus !== 'validated') {
    throw Errors.Conflict('Bank account validation changed during synchronization');
  }
  if (!hasBankSyncEntitlement(currentAccount.entitlements)) {
    throw Errors.Forbidden(
      'Bank account polling or statement entitlement was revoked during synchronization'
    );
  }

  const currentConnection = await connectionService.get(
    clientId,
    expectedConnectionId
  );

  if (!sameId(currentConnection.clientId, currentAccount.clientId)) {
    throw Errors.Conflict('Bank connection client changed during synchronization');
  }
  if (
    String(currentConnection.provider).toUpperCase()
    !== String(currentAccount.provider).toUpperCase()
  ) {
    throw Errors.Conflict('Bank connection provider changed during synchronization');
  }
  if (currentConnection.status !== 'active') {
    throw Errors.BankAuthFailed('Bank connection is no longer active');
  }

  const currentVersion = Number(currentConnection.credentialVersion);
  if (
    !Number.isSafeInteger(currentVersion)
    || currentVersion < 1
    || currentVersion !== expectedCredentialVersion
  ) {
    throw Errors.Conflict('Bank connection credentials rotated during synchronization');
  }

  if (
    !sameId(adapter?.connectionId, expectedConnectionId)
    || Number(adapter?.credentialVersion) !== expectedCredentialVersion
  ) {
    throw Errors.BankAuthFailed('Provider adapter identity or credential version is invalid');
  }

  return currentAccount;
}

function syncLeaseLostResult(bankAccountId, fenceGeneration, stage, {
  stored,
  processed,
  pageCount,
}) {
  logger.warn({
    bankAccountId: String(bankAccountId),
    fenceGeneration,
    stage,
  }, 'Bank sync stopped because lease ownership was lost');

  return {
    ok: false,
    stored,
    processed,
    pageCount,
    reason: `lease_lost_${stage}`,
    checkpointAdvanced: false,
  };
}

/**
 * Run synchronized ingestion for one account.
 * Shared by manual API and scheduled job.
 */
export function hasBankSyncEntitlement(entitlements) {
  return entitlements?.poll === true || entitlements?.statement === true;
}

export async function synchronizeBankAccount(clientId, bankAccountId, {
  workerId = newSyncWorkerId(),
  process = true,
} = {}) {
  const account = await BankAccount.findOne({ _id: bankAccountId, clientId });
  if (!account) throw Errors.BankAccountNotFound();
  if (account.connectionStatus !== 'connected') {
    throw Errors.Conflict('Bank account is not connected');
  }
  if (!account.connectionId) {
    throw Errors.Conflict('Bank account has no connection association');
  }
  if (account.validationStatus !== 'validated') {
    throw Errors.Conflict('Bank account has not completed validation');
  }
  if (!hasBankSyncEntitlement(account.entitlements)) {
    throw Errors.Forbidden('Account is not entitled for polling or statement import');
  }

  const caps = getBankProviderCapabilities(account.provider);
  if (!caps?.implemented) {
    throw Errors.BankProviderUnavailable(`Provider ${account.provider} is not implemented`);
  }

  const permittedCoopLab = (
    String(account.provider).toUpperCase() === 'COOP'
    && env.NODE_ENV !== 'production'
    && env.COOP_BANK_LAB_MODE === true
  );

  if (caps.operationalReady !== true && !permittedCoopLab) {
    throw Errors.BankProviderUnavailable(
      `Provider ${account.provider} is not operationally ready for customer sync`
    );
  }

  const strategy = strategyForProvider(account.provider);
  if (!strategy.supportsOperationalSync()) {
    throw Errors.Conflict(
      `Operational sync is not available for ${account.provider} under verified contracts`
    );
  }

  const lease = await acquireSyncLease(account._id, { workerId });
  const { fenceGeneration } = lease;

  let stored = 0;
  let processed = 0;
  let pageCount = 0;
  let lastCheckpointCandidate = null;
  let pageFailed = false;
  let pageError = null;

  try {
    const connection = await connectionService.get(
      clientId,
      account.connectionId
    );
    if (connection.status !== 'active') {
      throw Errors.BankAuthFailed('Bank connection is not active');
    }

    const expectedCredentialVersion = Number(connection.credentialVersion);
    if (
      !Number.isSafeInteger(expectedCredentialVersion)
      || expectedCredentialVersion < 1
    ) {
      throw Errors.BankAuthFailed('Bank connection credential version is invalid');
    }

    const adapter = await connectionService.getAdapterForConnection(connection);
    if (
      !sameId(adapter?.connectionId, connection._id)
      || Number(adapter?.credentialVersion) !== expectedCredentialVersion
    ) {
      throw Errors.BankAuthFailed('Provider adapter identity or credential version is invalid');
    }

    const session = await strategy.begin(
      account,
      connection,
      account.sync?.checkpoint || { type: 'none' },
      adapter
    );

    let exhausted = false;
    while (!exhausted) {
      await assertCurrentSyncContext({
        clientId,
        originalAccount: account,
        expectedConnectionId: connection._id,
        expectedCredentialVersion,
        adapter,
      });

      const renewedBeforeFetch = await extendSyncLease(account._id, {
        workerId,
        fenceGeneration,
      });

      if (!renewedBeforeFetch) {
        return syncLeaseLostResult(account._id, fenceGeneration, 'before_fetch', {
          stored,
          processed,
          pageCount,
        });
      }

      const page = await strategy.fetchPage(session);
      pageCount += 1;

      // A provider request may outlive the lease. Revalidate before accepting
      // any transaction from the fetched page.
      const renewedAfterFetch = await extendSyncLease(account._id, {
        workerId,
        fenceGeneration,
      });

      if (!renewedAfterFetch) {
        return syncLeaseLostResult(account._id, fenceGeneration, 'after_fetch', {
          stored,
          processed,
          pageCount,
        });
      }

      // Provider requests may overlap connection rotation, account
      // reassignment or entitlement revocation. Do not accept the page unless
      // the same account, connection and credential generation still own it.
      const acceptedAccount = await assertCurrentSyncContext({
        clientId,
        originalAccount: account,
        expectedConnectionId: connection._id,
        expectedCredentialVersion,
        adapter,
      });

      if (page.pageError) {
        pageFailed = true;
        pageError = page.pageError;
        break;
      }

      const batch = await ingestNormalizedTransactionBatch(acceptedAccount, page.items || [], {
        process,
        ingestionChannel: 'poll',
        connectionId: connection._id,
        expectedCredentialVersion,
      });
      stored += batch.stored;
      processed += batch.processed;

      // If any item failed validation in a way that indicates incomplete page
      // acceptance for checkpointing: only advance when pageError is absent
      // and we finished the page without strategy error.
      // Any required item that failed normalization, validation, ownership,
      // or durable persistence blocks checkpoint advancement for the window.
      // Duplicates with ok:true (created:false) are accepted.
      const failedItems = (batch.results || []).filter((r) => !r.ok);
      if (failedItems.length) {
        pageFailed = true;
        pageError = failedItems[0].code
          ? `ingest_item_failed:${failedItems[0].code}`
          : (failedItems[0].error || 'ingest_item_failed');
        break;
      }

      if (page.checkpointCandidate) {
        lastCheckpointCandidate = page.checkpointCandidate;
      }

      exhausted = Boolean(page.exhausted);
      if (!exhausted && !page.nextCursor && !(page.items || []).length) {
        exhausted = true;
      }
    }

    if (pageFailed) {
      await failSyncLease(account._id, {
        workerId,
        fenceGeneration,
        errorMessage: pageError || 'page_failed',
        errorCategory: 'partial_page',
      });
      await releaseSyncLease(account._id, { workerId, fenceGeneration });
      return {
        ok: false,
        stored,
        processed,
        pageCount,
        reason: pageError || 'partial_page',
        checkpointAdvanced: false,
      };
    }

    let checkpointAdvanced = false;
    if (lastCheckpointCandidate) {
      checkpointAdvanced = await advanceCheckpoint(account._id, {
        workerId,
        fenceGeneration,
        checkpoint: lastCheckpointCandidate,
        status: 'success',
      });
    } else {
      // No checkpoint candidate (empty successful run) — still clear success if no failure
      checkpointAdvanced = await advanceCheckpoint(account._id, {
        workerId,
        fenceGeneration,
        checkpoint: account.sync?.checkpoint || { type: 'none', value: null },
        status: 'success',
      });
    }

    // A failed conditional checkpoint write means this worker no longer has
    // authority to report a successful sync or emit a success audit.
    if (!checkpointAdvanced) {
      return syncLeaseLostResult(account._id, fenceGeneration, 'checkpoint', {
        stored,
        processed,
        pageCount,
      });
    }

    await releaseSyncLease(account._id, { workerId, fenceGeneration });

    await audit({
      clientId,
      estateId: account.estateId,
      action: 'BANK_SYNCED',
      resource: 'BankAccount',
      resourceId: account._id,
      metadata: {
        stored,
        processed,
        pageCount,
        checkpointAdvanced,
        fenceGeneration,
      },
    });

    return {
      ok: true,
      stored,
      processed,
      reconciled: processed,
      pageCount,
      checkpointAdvanced,
    };
  } catch (err) {
    await failSyncLease(account._id, {
      workerId,
      fenceGeneration,
      errorMessage: err.message,
      errorCategory: err.code || 'sync_error',
    }).catch(() => {});
    await releaseSyncLease(account._id, { workerId, fenceGeneration }).catch(() => {});
    throw err;
  }
}

export const bankSyncService = {
  synchronizeBankAccount,
  strategyForProvider,
};
