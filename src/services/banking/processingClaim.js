// src/services/banking/processingClaim.js
//
// Atomic claim acquisition / completion for BankTransaction processing.
// Uses processingClaimToken + processingClaimExpiresAt as the claim fence.

import crypto from 'crypto';
import { BankTransaction } from '../../models/BankTransaction.js';

const DEFAULT_CLAIM_TTL_MS = 5 * 60 * 1000;
const INITIAL_CLAIMABLE_STATES = ['RECEIVED', 'FAILED_RETRYABLE'];

export function newClaimToken() {
  return crypto.randomBytes(16).toString('hex');
}

/**
 * Atomically claim a transaction for processing.
 *
 * A CLAIMED record is reclaimable only when its explicit expiry has passed.
 * A CLAIMED record with a null/missing expiry is not assumed to be abandoned.
 */
export async function claimBankTransaction(transactionId, {
  ttlMs = DEFAULT_CLAIM_TTL_MS,
  claimToken = newClaimToken(),
} = {}) {
  const now = new Date();
  const expiresAt = new Date(now.getTime() + ttlMs);

  const doc = await BankTransaction.findOneAndUpdate(
    {
      _id: transactionId,
      $or: [
        {
          processingState: { $in: INITIAL_CLAIMABLE_STATES },
          processingClaimToken: null,
          processingClaimExpiresAt: null,
        },
        {
          processingState: {
            $in: [...INITIAL_CLAIMABLE_STATES, 'CLAIMED'],
          },
          processingClaimExpiresAt: { $lte: now },
        },
      ],
    },
    {
      $set: {
        processingState: 'CLAIMED',
        processingClaimToken: claimToken,
        processingClaimExpiresAt: expiresAt,
      },
      $inc: { processingAttempts: 1 },
    },
    { new: true }
  );

  if (doc) {
    return { claimed: true, doc, claimToken };
  }

  const current = await BankTransaction.findById(transactionId);
  return { claimed: false, doc: current, claimToken: null };
}

/**
 * Complete claim as POSTED — only the current, unexpired claim owner may succeed.
 * Extra fields cannot override the protected claim/processing fields.
 */
export async function completeClaim(transactionId, claimToken, extraSet = {}) {
  if (typeof claimToken !== 'string' || !claimToken) return null;

  const now = new Date();
  const doc = await BankTransaction.findOneAndUpdate(
    {
      _id: transactionId,
      processingClaimToken: claimToken,
      processingState: 'CLAIMED',
      processingClaimExpiresAt: { $gt: now },
    },
    {
      $set: {
        ...extraSet,
        processingState: 'POSTED',
        processingClaimToken: null,
        processingClaimExpiresAt: null,
        lastProcessingError: null,
      },
    },
    { new: true }
  );

  return doc;
}

/**
 * Release or fail a claim — only the current, unexpired claim owner.
 */
export async function failClaim(transactionId, claimToken, {
  terminal = false,
  errorMessage = null,
  processingState = null,
} = {}) {
  if (typeof claimToken !== 'string' || !claimToken) return null;

  const nextState = processingState
    || (terminal ? 'FAILED_TERMINAL' : 'FAILED_RETRYABLE');

  const now = new Date();
  const doc = await BankTransaction.findOneAndUpdate(
    {
      _id: transactionId,
      processingClaimToken: claimToken,
      processingState: 'CLAIMED',
      processingClaimExpiresAt: { $gt: now },
    },
    {
      $set: {
        processingState: nextState,
        processingClaimToken: null,
        processingClaimExpiresAt: null,
        lastProcessingError: errorMessage ? String(errorMessage).slice(0, 500) : null,
      },
    },
    { new: true }
  );

  return doc;
}

/**
 * Mark MANUAL_REVIEW under claim ownership, or from an unclaimed
 * RECEIVED/FAILED_RETRYABLE record. A tokenless caller cannot take over CLAIMED.
 */
export async function markManualReview(transactionId, claimToken, errorMessage = null) {
  if (claimToken) {
    return failClaim(transactionId, claimToken, {
      processingState: 'MANUAL_REVIEW',
      errorMessage,
    });
  }

  return BankTransaction.findOneAndUpdate(
    {
      _id: transactionId,
      processingState: { $in: INITIAL_CLAIMABLE_STATES },
      processingClaimToken: null,
      processingClaimExpiresAt: null,
    },
    {
      $set: {
        processingState: 'MANUAL_REVIEW',
        processingClaimToken: null,
        processingClaimExpiresAt: null,
        lastProcessingError: errorMessage ? String(errorMessage).slice(0, 500) : null,
      },
    },
    { new: true }
  );
}
