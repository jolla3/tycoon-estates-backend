// Runtime verification for G5 Payment receipt child-identity indexes.
// Installed ONLY by scripts/migrations/20261113_g5_payment_receipt_tenancy_index.js.
import mongoose from 'mongoose';

export const PAYMENT_RECEIPT_TENANCY_INDEX = Object.freeze({
  name: 'uniq_payment_mpesa_receipt_tenancy',
  key: Object.freeze({ mpesaReceiptId: 1, tenancyId: 1 }),
  partialFilterExpression: Object.freeze({ origin: 'MPESA' }),
});
export const PAYMENT_CREDIT_KEY_INDEX = Object.freeze({
  name: 'uniq_payment_credit_application_key',
  key: Object.freeze({ clientId: 1, creditApplicationKey: 1 }),
  partialFilterExpression: Object.freeze({ creditApplicationKey: Object.freeze({ $type: 'string' }) }),
});
export const LEGACY_RECEIPT_UNIQUE_INDEX_NAME = 'mpesaReceiptId_1';

const sameKey = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const samePartial = (a, b) => JSON.stringify(a || null) === JSON.stringify(b);

export function evaluatePaymentIndexes(indexes) {
  const list = Array.isArray(indexes) ? indexes : [];
  const byName = (n) => list.find((i) => i.name === n);
  const child = byName(PAYMENT_RECEIPT_TENANCY_INDEX.name);
  const credit = byName(PAYMENT_CREDIT_KEY_INDEX.name);
  // Any UNIQUE index whose key is exactly {mpesaReceiptId:1} blocks multi-Tenancy child Payments.
  const legacyBlocking = list.filter((i) => i.unique === true && sameKey(i.key, { mpesaReceiptId: 1 }));
  const reasons = [];
  if (!child || child.unique !== true || !sameKey(child.key, PAYMENT_RECEIPT_TENANCY_INDEX.key)
    || !samePartial(child.partialFilterExpression, PAYMENT_RECEIPT_TENANCY_INDEX.partialFilterExpression)) {
    reasons.push('child receipt/tenancy unique index absent or misconfigured');
  }
  if (!credit || credit.unique !== true || !sameKey(credit.key, PAYMENT_CREDIT_KEY_INDEX.key)
    || !samePartial(credit.partialFilterExpression, PAYMENT_CREDIT_KEY_INDEX.partialFilterExpression)) {
    reasons.push('credit application key unique index absent or misconfigured');
  }
  if (legacyBlocking.length) reasons.push('legacy unique mpesaReceiptId index still present');
  return { aligned: reasons.length === 0, reasons };
}

export async function assertPaymentReceiptIndexesAligned() {
  const col = mongoose.connection?.db?.collection('payments');
  if (!col) {
    const e = new Error('MongoDB connection unavailable');
    e.code = 'PAYMENT_RECEIPT_INDEX_NOT_ALIGNED';
    throw e;
  }
  const report = evaluatePaymentIndexes(await col.listIndexes().toArray());
  if (!report.aligned) {
    const e = new Error(report.reasons.join('; '));
    e.code = 'PAYMENT_RECEIPT_INDEX_NOT_ALIGNED';
    e.report = report;
    throw e;
  }
  return report;
}
