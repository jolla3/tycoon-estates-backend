// src/config/database.js
import mongoose from 'mongoose';
import { logger } from './logger.js';
import { env } from './environment.js';
import { ensureIndexes } from '../utils/ensureIndexes.js';
import { verifyAllocationCounters, _setAllocationCountersReadyForTests } from '../utils/allocationCounterReadiness.js';

let isConnected = false;
let topologySupportsTransactions = null;

function resetReadiness() {
  isConnected = false;
  topologySupportsTransactions = null;
  _setAllocationCountersReadyForTests(false);
}

export async function connectDatabase() {
  // Remain not-ready until all gates pass
  resetReadiness();

  mongoose.connection.on('error', (err) => logger.error({ err }, 'MongoDB connection error'));
  mongoose.connection.on('disconnected', () => {
    resetReadiness();
    logger.warn('MongoDB disconnected');
  });

  try {
    await mongoose.connect(env.MONGODB_URI);

    // Required financial indexes — fail closed
    await ensureIndexes();

    // Topology / transaction support. The same live verifier is used by the
    // isolated integration-test connection helper; no test-only bypass exists.
    await verifyMongoTransactionSupport();

    // Allocation counter verification (default ON). Disabling must never enable financial posting:
    // poster still requires areAllocationCountersReady() which stays false when verify is skipped.
    const verifyCounters = process.env.G3_VERIFY_ALLOCATION_COUNTERS !== '0';
    if (verifyCounters) {
      const report = await verifyAllocationCounters({ setReady: true });
      if (!report.ok) {
        const sample = (report.issues || []).slice(0, 5).map((i) => i.type).join(', ');
        throw new Error(
          `Allocation integrity verification failed: ${report.issues.length} issue(s)`
          + (sample ? ` (e.g. ${sample})` : '')
          + '. Resolve data issues / run disposable backfill, then restart.'
        );
      }
    } else {
      logger.warn(
        'G3_VERIFY_ALLOCATION_COUNTERS=0 — counters not verified; financial posting remains blocked until verifyAllocationCounters succeeds'
      );
    }

    isConnected = true;
    logger.info('Connected to MongoDB (indexes ready)');
  } catch (err) {
    resetReadiness();
    try {
      await mongoose.connection.close();
    } catch (_) {
      /* ignore */
    }
    throw err;
  }
}

export async function disconnectDatabase() {
  await mongoose.connection.close();
  resetReadiness();
}

export function isDatabaseReady() {
  return isConnected && mongoose.connection.readyState === 1;
}

/** null = unknown, true/false = verified */
/**
 * Verify transaction capability from the connected server's live hello response.
 * Cached state remains fail-closed (null) when the topology cannot be verified.
 */
export async function verifyMongoTransactionSupport() {
  try {
    const admin = mongoose.connection.db?.admin();
    if (!admin) throw new Error('MongoDB connection is not ready for topology verification');
    const status = await admin.command({ hello: 1 })
      .catch(() => admin.command({ ismaster: 1 }));
    topologySupportsTransactions = Boolean(status.setName || status.msg === 'isdbgrid');
    if (!topologySupportsTransactions) {
      logger.warn(
        'MongoDB topology does not support multi-document transactions (standalone). '
        + 'Financial posting requires a replica set.'
      );
    }
    return topologySupportsTransactions;
  } catch (err) {
    topologySupportsTransactions = null;
    logger.error({ error: err.message }, 'Could not determine MongoDB transaction support');
    return null;
  }
}

export function supportsMongoTransactions() {
  return topologySupportsTransactions;
}
