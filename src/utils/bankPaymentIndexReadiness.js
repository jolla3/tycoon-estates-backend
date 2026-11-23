// Runtime verification for Bank receipt allocation-child and credit provenance indexes.
// Both indexes are installed only by the guarded G5 Bank child-identity migration.
import mongoose from 'mongoose';
import { isDeepStrictEqual } from 'node:util';

export const BANK_PAYMENT_CHILD_INDEX = Object.freeze({
  name: 'uniq_payment_bank_receipt_tenancy',
  key: Object.freeze({ bankTransactionId: 1, tenancyId: 1 }),
  partialFilterExpression: Object.freeze({
    origin: 'BANK',
    bankTransactionId: Object.freeze({ $type: 'objectId' }),
  }),
});

export const BANK_CREDIT_MOVEMENT_INDEX = Object.freeze({
  name: 'idx_tenant_credit_bank_receipt',
  key: Object.freeze({ bankTransactionId: 1 }),
  partialFilterExpression: Object.freeze({
    bankTransactionId: Object.freeze({ $type: 'objectId' }),
  }),
});

export const LEGACY_BANK_RECEIPT_UNIQUE_INDEX_NAME = 'bankTransactionId_1';

const sameKey = (a, b) => {
  const left = Object.entries(a || {});
  const right = Object.entries(b || {});
  return left.length === right.length
    && left.every(([key, value], index) =>
      key === right[index][0] && isDeepStrictEqual(value, right[index][1])
    );
};
const samePartial = (a, b) => isDeepStrictEqual(a || null, b || null);

export function evaluateBankPaymentIndexes(indexes) {
  const list = Array.isArray(indexes) ? indexes : [];
  const target = list.find((index) => index.name === BANK_PAYMENT_CHILD_INDEX.name);
  const blocking = list.filter((index) =>
    index.unique === true
    && index.name !== BANK_PAYMENT_CHILD_INDEX.name
    && Object.keys(index.key || {}).includes('bankTransactionId')
  );
  const reasons = [];
  if (!target || target.unique !== true
    || !sameKey(target.key, BANK_PAYMENT_CHILD_INDEX.key)
    || !samePartial(target.partialFilterExpression, BANK_PAYMENT_CHILD_INDEX.partialFilterExpression)) {
    reasons.push('Bank receipt/destination-tenancy unique child index absent or misconfigured');
  }
  if (blocking.length) reasons.push('legacy unique bankTransactionId index still blocks multiple Bank children');
  return { aligned: reasons.length === 0, reasons, blockingIndexNames: blocking.map((index) => index.name) };
}

export function evaluateBankCreditMovementIndexes(indexes) {
  const list = Array.isArray(indexes) ? indexes : [];
  const target = list.find((index) => index.name === BANK_CREDIT_MOVEMENT_INDEX.name);
  const aligned = Boolean(target)
    && target.unique !== true
    && sameKey(target.key, BANK_CREDIT_MOVEMENT_INDEX.key)
    && samePartial(target.partialFilterExpression, BANK_CREDIT_MOVEMENT_INDEX.partialFilterExpression);
  return {
    aligned,
    reasons: aligned ? [] : ['Bank credit-movement provenance lookup index absent or misconfigured'],
  };
}

export async function assertBankPaymentIndexesAligned() {
  const db = mongoose.connection?.db;
  if (!db) {
    const error = new Error('MongoDB connection unavailable for Bank child-index verification');
    error.code = 'BANK_PAYMENT_INDEX_NOT_ALIGNED';
    throw error;
  }
  const [paymentIndexes, movementIndexes] = await Promise.all([
    db.collection('payments').listIndexes().toArray(),
    db.collection('tenantcreditmovements').listIndexes().toArray(),
  ]);
  const paymentReport = evaluateBankPaymentIndexes(paymentIndexes);
  const movementReport = evaluateBankCreditMovementIndexes(movementIndexes);
  const reasons = [...paymentReport.reasons, ...movementReport.reasons];
  if (reasons.length) {
    const error = new Error(reasons.join('; '));
    error.code = 'BANK_PAYMENT_INDEX_NOT_ALIGNED';
    error.report = { payment: paymentReport, movements: movementReport };
    throw error;
  }
  return { payment: paymentReport, movements: movementReport };
}
