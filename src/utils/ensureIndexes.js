// Non-destructive index ensure. Required financial index failures set readiness flag.
// G3.1: RentCharge identity UNIQUE indexes are NOT created here — explicit migration owns them.
import mongoose from 'mongoose';
import { logger } from '../config/logger.js';
import { refreshBillingIndexReadiness, getBillingIndexReport } from './billingIndexReadiness.js';
import { inspectHouseTypeIndexes } from './houseTypeIndexReadiness.js';
import { inspectManualPaymentReferenceIndex } from './manualPaymentIndexReadiness.js';
import { inspectDepositMovementIndex } from './depositMovementIndexReadiness.js';

let financialIndexesReady = false;
let lastIndexError = null;

export function areFinancialIndexesReady() {
  return financialIndexesReady;
}

export function areFinancialIndexReportsAligned({
  billing, houseTypeIndexes, manualPaymentIndex, depositMovementIndex,
} = {}) {
  return Boolean(
    billing?.aligned
    && houseTypeIndexes?.aligned
    && manualPaymentIndex?.aligned
    && depositMovementIndex?.aligned
  );
}

export function getFinancialIndexError() {
  return lastIndexError;
}

/** Test helper — do not use in production paths. */
export function _setFinancialIndexesReadyForTests(value) {
  financialIndexesReady = Boolean(value);
  if (value) lastIndexError = null;
}

export const REQUIRED_MODELS = [
  'Tenancy',
  'RentCharge',
  'Ledger',
  'Payment',
  'PaymentAllocation',
  'Deposit',
  'DepositMovement',
  'BankTransaction',
  'Subscription',
];

export async function ensureIndexes() {
  if (!mongoose.connection.db) {
    logger.warn('ensureIndexes skipped — no database connection');
    financialIndexesReady = false;
    lastIndexError = 'no database connection';
    return;
  }
  try {
    // Fail closed on import errors
    await import('../models/Tenancy.js');
    await import('../models/RentCharge.js');
    await import('../models/Ledger.js');
    await import('../models/Payment.js');
    await import('../models/PaymentAllocation.js');
    await import('../models/Deposit.js');
    await import('../models/DepositMovement.js');
    await import('../models/BankTransaction.js');
    await import('../models/Subscription.js');

    for (const name of REQUIRED_MODELS) {
      const model = mongoose.models[name];
      if (!model) {
        throw new Error(`Required model not registered: ${name}`);
      }
      // createIndexes is create-only for schema-declared (non-identity-unique) indexes.
      // RentCharge schema intentionally omits the unique identity indexes so this path
      // cannot install them before migration preflight.
      await model.createIndexes();
    }

    // Live inspection of RentCharge identity indexes (does not create/drop)
    await refreshBillingIndexReadiness();
    const billing = getBillingIndexReport();
    if (!billing?.aligned) {
      logger.warn(
        { reason: billing?.reason, report: billing },
        'RentCharge identity indexes not aligned — billing generation must stay disabled until migration completes'
      );
    }

    // HouseType and immutable plan-version schemas have autoIndex:false.
    // Their indexes are installed only by the guarded G3.2 migration and are
    // verified here. Missing or conflicting definitions fail closed globally.
    const houseTypeIndexes = await inspectHouseTypeIndexes();
    const manualPaymentIndex = await inspectManualPaymentReferenceIndex();
    const depositMovementIndex = await inspectDepositMovementIndex();
    financialIndexesReady = areFinancialIndexReportsAligned({
      billing, houseTypeIndexes, manualPaymentIndex, depositMovementIndex,
    });
    const readinessReasons = [
      !billing?.aligned ? `RentCharge: ${billing?.reason || 'not aligned'}` : null,
      !houseTypeIndexes?.aligned ? `HouseType: ${houseTypeIndexes?.reason || 'not aligned'}` : null,
      !manualPaymentIndex?.aligned ? `Manual Payment: ${manualPaymentIndex?.reason || 'not aligned'}` : null,
      !depositMovementIndex?.aligned ? `DepositMovement: ${depositMovementIndex?.reason || 'not aligned'}` : null,
    ].filter(Boolean);
    lastIndexError = financialIndexesReady ? null : readinessReasons.join('; ');

    if (financialIndexesReady) {
      logger.info('Required financial, RentCharge identity, G3.2 HouseType, Subscription and DepositMovement indexes are aligned');
    } else {
      logger.warn(
        { billingReport: billing, houseTypeIndexReport: houseTypeIndexes, depositMovementIndex },
        `Financial posting disabled: ${readinessReasons.join('; ')}`
      );
    }
  } catch (err) {
    financialIndexesReady = false;
    lastIndexError = err.message;
    logger.error({ error: err.message }, 'Required financial index ensure FAILED — financial writes unsafe');
    throw err;
  }
}
