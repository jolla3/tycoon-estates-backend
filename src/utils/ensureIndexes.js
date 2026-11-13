// Non-destructive index ensure. Required financial index failures set readiness flag.
// G3.1: RentCharge identity UNIQUE indexes are NOT created here — explicit migration owns them.
// G5 unique indexes are also migration-controlled. Only non-unique operational indexes are provisioned.
import mongoose from 'mongoose';
import { logger } from '../config/logger.js';
import { refreshBillingIndexReadiness, getBillingIndexReport } from './billingIndexReadiness.js';
import { inspectHouseTypeIndexes } from './houseTypeIndexReadiness.js';
import { inspectManualPaymentReferenceIndex } from './manualPaymentIndexReadiness.js';
import { inspectDepositMovementIndex } from './depositMovementIndexReadiness.js';
import {
  provisionMpesaOperationalIndexes,
  inspectMpesaIndexes,
} from './mpesaIndexReadiness.js';

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

async function ensureMpesaOperationalIndexes() {
  try {
    await import('../models/MpesaIngestionEvent.js');
    await import('../models/MpesaMerchantProfile.js');
    await import('../models/MpesaTransaction.js');
    await import('../models/MpesaPullCheckpoint.js');
    // Do NOT call model.createIndexes() — schemas declare unique indexes and autoIndex is false.
    const provisioned = await provisionMpesaOperationalIndexes();
    const report = await inspectMpesaIndexes();
    if (!report.gates?.durableInbox) {
      logger.warn(
        { gates: report.gates, provisioned },
        'G5 inbox indexes incomplete — M-PESA ingestion readiness is not complete'
      );
    } else {
      logger.info({ gates: report.gates, created: provisioned.created }, 'G5 operational indexes inspected');
    }
  } catch (err) {
    logger.error({ error: err.message }, 'G5 operational index provisioning failed — API startup continues');
  }
}

export async function ensureIndexes() {
  if (!mongoose.connection.db) {
    logger.warn('ensureIndexes skipped — no database connection');
    financialIndexesReady = false;
    lastIndexError = 'no database connection';
    return;
  }
  try {
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
      await model.createIndexes();
    }

    await refreshBillingIndexReadiness();
    const billing = getBillingIndexReport();
    if (!billing?.aligned) {
      logger.warn(
        { reason: billing?.reason, report: billing },
        'RentCharge identity indexes not aligned — billing generation must stay disabled until migration completes'
      );
    }

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

    await ensureMpesaOperationalIndexes();
  } catch (err) {
    financialIndexesReady = false;
    lastIndexError = err.message;
    logger.error({ error: err.message }, 'Required financial index ensure FAILED — financial writes unsafe');
    throw err;
  }
}
