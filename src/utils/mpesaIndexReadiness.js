// src/utils/mpesaIndexReadiness.js
//
// G5.3 — Read-only readiness for M-PESA collections.
// Does not create indexes. Schema declarations are not live DB proof.

import mongoose from 'mongoose';
import { logger } from '../config/logger.js';

export async function inspectMpesaIndexes() {
  if (!mongoose.connection?.db) {
    return {
      ready: false,
      reason: 'no_database_connection',
      collections: {},
    };
  }

  const db = mongoose.connection.db;
  const report = {
    ready: true,
    reason: null,
    collections: {},
    gates: {
      durableInbox: false,
      merchantRegistration: false,
      canonicalReceiptIdentity: false,
      pullReconciliation: false,
    },
  };

  async function list(name) {
    try {
      return await db.collection(name).indexes();
    } catch (err) {
      return { error: err.message };
    }
  }

  report.collections.mpesamerchantprofiles = await list('mpesamerchantprofiles');
  report.collections.mpesaingestionevents = await list('mpesaingestionevents');
  report.collections.mpesatransactions = await list('mpesatransactions');
  report.collections.mpesapullcheckpoints = await list('mpesapullcheckpoints');

  const has = (indexes, keyFields) => {
    if (!Array.isArray(indexes)) return false;
    return indexes.some((idx) => {
      const keys = Object.keys(idx.key || {});
      return keyFields.every((k, i) => keys[i] === k);
    });
  };

  const merchant = report.collections.mpesamerchantprofiles;
  report.gates.merchantRegistration = has(merchant, ['clientId', 'businessShortCode']);

  const events = report.collections.mpesaingestionevents;
  report.gates.durableInbox = Array.isArray(events) && events.length > 0;

  const checkpoints = report.collections.mpesapullcheckpoints;
  report.gates.pullReconciliation = has(checkpoints, ['merchantProfileId']);

  // Canonical identity intentionally not ready until B01/B02 + guarded migration approval
  report.gates.canonicalReceiptIdentity = false;

  report.ready = report.gates.durableInbox && report.gates.merchantRegistration;
  if (!report.ready) {
    report.reason = 'mpesa_indexes_incomplete';
  }

  logger.debug({ gates: report.gates }, 'M-PESA index readiness inspected');
  return report;
}
