// src/services/banking/syncCoordination.service.js
//
// Per-account sync lease + fence generation on BankAccount.sync.
// Redis job locks alone cannot stop a stale worker from writing checkpoints.

import crypto from 'crypto';
import { BankAccount } from '../../models/BankAccount.js';
import { Errors } from '../../utils/errors.js';

const DEFAULT_LEASE_MS = 2 * 60 * 1000;

export function newSyncWorkerId() {
  return `sync-${crypto.randomBytes(8).toString('hex')}`;
}

function liveLeaseFilter(bankAccountId, { workerId, fenceGeneration }, now) {
  return {
    _id: bankAccountId,
    'sync.leaseOwner': workerId,
    'sync.fenceGeneration': fenceGeneration,
    'sync.leaseExpiresAt': { $gt: now },
  };
}

/**
 * Acquire exclusive sync lease and bump fence generation.
 * Concurrent callers fail closed if lease is held by another non-expired owner.
 */
export async function acquireSyncLease(bankAccountId, {
  workerId = newSyncWorkerId(),
  ttlMs = DEFAULT_LEASE_MS,
} = {}) {
  const now = new Date();
  const leaseExpiresAt = new Date(now.getTime() + ttlMs);

  const updated = await BankAccount.findOneAndUpdate(
    {
      _id: bankAccountId,
      $or: [
        { 'sync.leaseExpiresAt': null, 'sync.leaseOwner': null },
        { 'sync.leaseExpiresAt': { $lte: now } },
      ],
    },
    {
      $set: {
        'sync.status': 'running',
        'sync.leaseOwner': workerId,
        'sync.leaseExpiresAt': leaseExpiresAt,
        'sync.lastAttemptAt': now,
        'sync.lastError': null,
        'sync.lastErrorCategory': null,
      },
      $inc: { 'sync.fenceGeneration': 1 },
    },
    { new: true }
  );

  if (!updated) {
    const current = await BankAccount.findById(bankAccountId).lean();
    throw Errors.Conflict(
      `Sync lease held by another worker until ${current?.sync?.leaseExpiresAt || 'unknown'}`
    );
  }

  return {
    workerId,
    fenceGeneration: updated.sync?.fenceGeneration || 1,
    leaseExpiresAt: updated.sync?.leaseExpiresAt,
    account: updated,
  };
}

/**
 * Conditional checkpoint advance — requires matching fence + owner.
 * Returns false if stale (another generation owns the account).
 */
export async function advanceCheckpoint(bankAccountId, {
  workerId,
  fenceGeneration,
  checkpoint,
  status = 'success',
}) {
  const now = new Date();
  const result = await BankAccount.findOneAndUpdate(
    liveLeaseFilter(bankAccountId, { workerId, fenceGeneration }, now),
    {
      $set: {
        'sync.checkpoint.type': checkpoint.type || 'none',
        'sync.checkpoint.value': checkpoint.value ?? null,
        'sync.checkpoint.acceptedThrough': checkpoint.acceptedThrough ?? null,
        'sync.status': status,
        'sync.lastSuccessAt': now,
        'sync.lastError': null,
        'sync.lastErrorCategory': null,
        lastSyncedAt: now,
      },
    },
    { new: true }
  );
  return Boolean(result);
}

export async function failSyncLease(bankAccountId, {
  workerId,
  fenceGeneration,
  errorMessage,
  errorCategory = 'sync_failed',
}) {
  const now = new Date();
  const result = await BankAccount.findOneAndUpdate(
    liveLeaseFilter(bankAccountId, { workerId, fenceGeneration }, now),
    {
      $set: {
        'sync.status': 'failed',
        'sync.lastError': errorMessage ? String(errorMessage).slice(0, 500) : null,
        'sync.lastErrorCategory': errorCategory,
      },
    },
    { new: true }
  );
  return Boolean(result);
}

/**
 * Release lease only if we still own the fence generation.
 */
export async function releaseSyncLease(bankAccountId, { workerId, fenceGeneration }) {
  const now = new Date();
  const result = await BankAccount.findOneAndUpdate(
    liveLeaseFilter(bankAccountId, { workerId, fenceGeneration }, now),
    {
      $set: {
        'sync.leaseOwner': null,
        'sync.leaseExpiresAt': null,
      },
    },
    { new: true }
  );
  return Boolean(result);
}

/**
 * Heartbeat / extend lease for long pages (same fence).
 */
export async function extendSyncLease(bankAccountId, {
  workerId,
  fenceGeneration,
  ttlMs = DEFAULT_LEASE_MS,
}) {
  const now = new Date();
  const leaseExpiresAt = new Date(now.getTime() + ttlMs);
  const result = await BankAccount.findOneAndUpdate(
    liveLeaseFilter(bankAccountId, { workerId, fenceGeneration }, now),
    { $set: { 'sync.leaseExpiresAt': leaseExpiresAt } },
    { new: true }
  );
  return Boolean(result);
}
