// Runtime verification for the explicit G3.3 MANUAL payment idempotency index.
// The unique index is installed only by the guarded migration after duplicate preflight.
import mongoose from 'mongoose';

export const MANUAL_PAYMENT_REFERENCE_INDEX = Object.freeze({
  name: 'uniq_client_manual_payment_reference',
  key: Object.freeze({ clientId: 1, origin: 1, paymentReference: 1 }),
  partialFilterExpression: Object.freeze({
    origin: 'MANUAL',
    paymentReference: Object.freeze({ $type: 'string', $gt: '' }),
  }),
});

function sameOrderedKey(actual, expected) {
  if (!actual || Object.keys(actual).length !== Object.keys(expected).length) return false;
  return Object.keys(expected).every((field, index) =>
    Object.keys(actual)[index] === field && actual[field] === expected[field]
  );
}

function samePartial(actual) {
  return actual?.origin === 'MANUAL'
    && actual?.paymentReference?.$type === 'string'
    && actual?.paymentReference?.$gt === ''
    && Object.keys(actual || {}).length === 2
    && Object.keys(actual.paymentReference || {}).length === 2;
}

export async function inspectManualPaymentReferenceIndex() {
  const collection = mongoose.connection?.db?.collection('payments');
  if (!collection) {
    return { aligned: false, reason: 'MongoDB connection unavailable', expected: MANUAL_PAYMENT_REFERENCE_INDEX };
  }
  try {
    const indexes = await collection.listIndexes().toArray();
    const index = indexes.find((item) => item.name === MANUAL_PAYMENT_REFERENCE_INDEX.name) || null;
    const aligned = Boolean(index
      && index.unique === true
      && sameOrderedKey(index.key, MANUAL_PAYMENT_REFERENCE_INDEX.key)
      && samePartial(index.partialFilterExpression));
    return {
      aligned,
      reason: aligned ? null : 'Required unique MANUAL paymentReference index is absent or misconfigured',
      index: index ? {
        name: index.name, key: index.key, unique: index.unique === true,
        partialFilterExpression: index.partialFilterExpression || null,
      } : null,
      expected: MANUAL_PAYMENT_REFERENCE_INDEX,
    };
  } catch (error) {
    return { aligned: false, reason: `Unable to inspect manual payment index: ${error.message}`, expected: MANUAL_PAYMENT_REFERENCE_INDEX };
  }
}

export async function assertManualPaymentReferenceIndexAligned() {
  const report = await inspectManualPaymentReferenceIndex();
  if (!report.aligned) {
    const error = new Error(report.reason || 'Manual payment idempotency index is not aligned');
    error.code = 'MANUAL_PAYMENT_INDEX_NOT_ALIGNED';
    error.report = report;
    throw error;
  }
  return report;
}
