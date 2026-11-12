// src/utils/mpesaIndexReadiness.js
//
// G5.3 — Read-only readiness for M-PESA collections.
// Does not create indexes. Schema declarations are not live DB proof.
// Verifies exact key order, uniqueness and preferred index names where required.

import mongoose from 'mongoose';
import { logger } from '../config/logger.js';

function isExactIndex(indexes, { key, unique = false, name = null }) {
  if (!Array.isArray(indexes)) return false;
  return indexes.some((idx) => {
    if (!idx?.key) return false;
    const keyOk = JSON.stringify(idx.key) === JSON.stringify(key);
    const uniqueOk = Boolean(idx.unique) === Boolean(unique);
    const nameOk = name == null || idx.name === name;
    return keyOk && uniqueOk && nameOk;
  });
}

export async function inspectMpesaIndexes() {
  if (!mongoose.connection?.db) {
    return {
      ready: false,
      reason: 'no_database_connection',
      collections: {},
      gates: {
        durableInbox: false,
        merchantRegistration: false,
        canonicalReceiptIdentity: false,
        pullReconciliation: false,
      },
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
  report.collections.mpesatransactions = await list('mpesatransed');
  report.collections.mpesapullcheckpoints = await list('mpesapullcheckpoints');

  const merchant = report.collections.mpesamerchantprofiles;
  report.gates.merchantRegistration = isExactIndex(merchant, {
    key: { clientId: 1, businessShortCode: 1 },
    unique: true,
    name: 'uniq_client_business_shortcode',
  });

  const events = report.collections.mpesaingestionevents;
  report.gates.durableInbox =
    Array.isArray(events)
    && events.some((idx) => idx.key && Object.keys(idx.key)[0] === 'state');

  const checkpoints = report.collections.mpesapullcheckpoints;
  report.gates.pullReconciliation = isExactIndex(checkpoints, {
    key: { merchantProfileId: 1 },
    unique: true,
    name: 'uniq_mpesa_pull_checkpoint_profile',
  });

  report.gates.canonicalReceiptIdentity = false;

  report.ready = report.gates.durableInbox && report.gates.merchantRegistration;
  if (!report.ready) {
    report.reason = 'mpesa_indexes_incomplete';
  }

  logger.debug({ gates: report.gates }, 'M-PESA index readiness inspected');
  return report;
}
