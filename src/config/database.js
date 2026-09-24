// src/config/database.js
import mongoose from 'mongoose';
import { logger } from './logger.js';
import { env } from './environment.js';
import { ensureIndexes } from '../utils/ensureIndexes.js';

let isConnected = false;
let topologySupportsTransactions = null;

export async function connectDatabase() {
  mongoose.connection.on('error', (err) => logger.error({ err }, 'MongoDB connection error'));
  mongoose.connection.on('disconnected', () => {
    isConnected = false;
    topologySupportsTransactions = null;
    logger.warn('MongoDB disconnected');
  });

  await mongoose.connect(env.MONGODB_URI);
  isConnected = true;
  logger.info('Connected to MongoDB');

  // Align legacy indexes (estate-scoped subscription / pre-chargeType rent)
  // with the current Client-scoped / multi-charge schemas. Safe to re-run.
  try {
    await ensureIndexes();
  } catch (err) {
    logger.warn({ error: err.message }, 'Index alignment failed — continuing startup');
  }

  try {
    const admin = mongoose.connection.db.admin();
    const status = await admin.command({ hello: 1 }).catch(() => admin.command({ ismaster: 1 }));
    // Replica set / mongos support multi-document transactions; standalone does not.
    topologySupportsTransactions = Boolean(status.setName || status.msg === 'isdbgrid');
    if (!topologySupportsTransactions) {
      logger.warn(
        'MongoDB topology does not support multi-document transactions (standalone). ' +
          'Financial reconciliation requires a replica set in production.'
      );
    } else {
      logger.info({ setName: status.setName || 'mongos' }, 'MongoDB topology supports transactions');
    }
  } catch (err) {
    logger.warn({ error: err.message }, 'Could not determine MongoDB transaction support');
    topologySupportsTransactions = null;
  }
}

export async function disconnectDatabase() {
  await mongoose.connection.close();
  isConnected = false;
  topologySupportsTransactions = null;
}

export function isDatabaseReady() {
  return isConnected && mongoose.connection.readyState === 1;
}

/** null = unknown, true/false = verified */
export function supportsMongoTransactions() {
  return topologySupportsTransactions;
}
