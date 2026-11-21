// Runtime verification for ManualReceipt identity indexes.
// Unique indexes are installed by the guarded migration after preflight.
import mongoose from 'mongoose';
import { MANUAL_RECEIPT_INDEXES } from '../models/ManualReceipt.js';

function sameOrderedKey(actual, expected) {
  if (!actual || Object.keys(actual).length !== Object.keys(expected).length) return false;
  return Object.keys(expected).every((field, index) =>
    Object.keys(actual)[index] === field && actual[field] === expected[field]
  );
}

function samePartialRef(actual) {
  return actual?.paymentReference?.$type === 'string'
    && actual?.paymentReference?.$gt === ''
    && Object.keys(actual || {}).length === 1
    && Object.keys(actual.paymentReference || {}).length === 2;
}

export async function inspectManualReceiptIndexes() {
  const collection = mongoose.connection?.db?.collection('manualreceipts');
  if (!collection) {
    return {
      aligned: false,
      reason: 'MongoDB connection unavailable',
      expected: MANUAL_RECEIPT_INDEXES,
    };
  }
  try {
    const indexes = await collection.listIndexes().toArray();
    const idemp = indexes.find((i) => i.name === MANUAL_RECEIPT_INDEXES.IDEMPOTENCY.name) || null;
    const ref = indexes.find((i) => i.name === MANUAL_RECEIPT_INDEXES.REFERENCE.name) || null;
    const idempOk = Boolean(
      idemp
      && idemp.unique === true
      && sameOrderedKey(idemp.key, MANUAL_RECEIPT_INDEXES.IDEMPOTENCY.key)
    );
    const refOk = Boolean(
      ref
      && ref.unique === true
      && sameOrderedKey(ref.key, MANUAL_RECEIPT_INDEXES.REFERENCE.key)
      && samePartialRef(ref.partialFilterExpression)
    );
    const aligned = idempOk && refOk;
    return {
      aligned,
      reason: aligned
        ? null
        : 'Required ManualReceipt identity indexes are absent or misconfigured',
      idempotency: idempOk,
      reference: refOk,
      expected: MANUAL_RECEIPT_INDEXES,
    };
  } catch (error) {
    return {
      aligned: false,
      reason: `Unable to inspect ManualReceipt indexes: ${error.message}`,
      expected: MANUAL_RECEIPT_INDEXES,
    };
  }
}

export async function assertManualReceiptIndexesAligned() {
  const report = await inspectManualReceiptIndexes();
  if (!report.aligned) {
    const error = new Error(report.reason || 'ManualReceipt identity indexes are not aligned');
    error.code = 'MANUAL_RECEIPT_INDEX_NOT_ALIGNED';
    error.report = report;
    throw error;
  }
  return report;
}
