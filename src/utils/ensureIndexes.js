// src/utils/ensureIndexes.js
//
// One-time-safe index alignment after schema changes.
// Drops known *stale* unique indexes that contradict the current models,
// then relies on mongoose model indexes for the correct definitions.
//
// Does NOT drop arbitrary indexes. Does NOT delete data.

import mongoose from 'mongoose';
import { logger } from '../config/logger.js';

async function dropIndexIfExists(collection, indexName) {
  try {
    const indexes = await collection.indexes();
    if (!indexes.some((idx) => idx.name === indexName)) return false;
    await collection.dropIndex(indexName);
    logger.info({ collection: collection.collectionName, index: indexName }, 'Dropped stale Mongo index');
    return true;
  } catch (err) {
    if (err?.code === 27 || /index not found/i.test(err?.message || '')) return false;
    logger.warn(
      { collection: collection.collectionName, index: indexName, error: err.message },
      'Could not drop stale index'
    );
    return false;
  }
}

/** Drop unique indexes whose key matches a known legacy pattern (name-agnostic). */
async function dropUniqueIndexesByKeyPattern(collection, keyPattern) {
  let dropped = 0;
  try {
    const indexes = await collection.indexes();
    for (const idx of indexes) {
      if (!idx.unique || idx.name === '_id_') continue;
      const key = idx.key || {};
      const keyNames = Object.keys(key);
      const patternNames = Object.keys(keyPattern);
      if (keyNames.length !== patternNames.length) continue;
      if (!patternNames.every((k) => key[k] === keyPattern[k])) continue;
      try {
        await collection.dropIndex(idx.name);
        dropped += 1;
        logger.info(
          { collection: collection.collectionName, index: idx.name, key },
          'Dropped stale unique index by key pattern'
        );
      } catch (err) {
        if (err?.code === 27 || /index not found/i.test(err?.message || '')) continue;
        logger.warn(
          { collection: collection.collectionName, index: idx.name, error: err.message },
          'Could not drop stale unique index by pattern'
        );
      }
    }
  } catch (err) {
    logger.warn(
      { collection: collection.collectionName, error: err.message },
      'Could not list indexes for pattern drop'
    );
  }
  return dropped;
}

/**
 * Align indexes with Client-scoped Subscription and multi-charge RentCharge.
 *
 * Stale production indexes:
 * - subscriptions unique on estateId alone → null estateId collisions
 * - rentcharges unique on estateId+houseId+period (no chargeType)
 */
export async function ensureIndexes() {
  const db = mongoose.connection.db;
  if (!db) {
    logger.warn('ensureIndexes skipped — no database connection');
    return;
  }

  const subscriptions = db.collection('subscriptions');
  const rentcharges = db.collection('rentcharges');

  await dropIndexIfExists(subscriptions, 'estateId_1');
  await dropIndexIfExists(subscriptions, 'estateId_1_unique');
  await dropUniqueIndexesByKeyPattern(subscriptions, { estateId: 1 });

  await dropIndexIfExists(rentcharges, 'estateId_1_houseId_1_period_1');
  await dropIndexIfExists(rentcharges, 'estateId_1_houseId_1_period_1_unique');
  await dropIndexIfExists(rentcharges, 'estateId_1_houseId_1_period_1_chargeType_1');
  await dropUniqueIndexesByKeyPattern(rentcharges, { estateId: 1, houseId: 1, period: 1 });

  try {
    const { Subscription } = await import('../models/Subscription.js');
    const { RentCharge } = await import('../models/RentCharge.js');
    const { Ledger } = await import('../models/Ledger.js');
    await Subscription.syncIndexes();
    
  // Multi-line OTHER billing: unique key now includes description
  try {
    await mongoose.connection.collection('rentcharges').dropIndex('clientId_1_houseId_1_period_1_chargeType_1');
  } catch (_) { /* may not exist */ }

  await RentCharge.syncIndexes();
    await Ledger.syncIndexes();
    logger.info('Subscription, RentCharge, and Ledger indexes synchronized with schema');
  } catch (err) {
    logger.warn({ error: err.message }, 'Model syncIndexes failed — continuing with existing indexes');
  }
}
