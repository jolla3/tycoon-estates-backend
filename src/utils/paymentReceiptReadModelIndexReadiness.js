// Runtime gate for the receipt-envelope Payments list. Index declarations alone are
// not proof of installation (ManualReceipt and M-PESA have autoIndex:false).
import mongoose from 'mongoose';

const REQUIRED = Object.freeze([
  {
    collection: 'manualreceipts',
    name: 'clientId_1_estateId_1_paymentDate_-1',
    key: { clientId: 1, estateId: 1, paymentDate: -1 },
  },
  {
    collection: 'banktransactions',
    name: 'idx_bank_posted_receipts',
    key: { clientId: 1, estateId: 1, processingState: 1, eventType: 1, matchStatus: 1, transactionDate: -1 },
  },
  {
    collection: 'payments',
    name: 'idx_payment_legacy_manual_list',
    key: { clientId: 1, estateId: 1, origin: 1, paymentDate: -1 },
  },
  {
    collection: 'tenantcreditmovements',
    name: 'clientId_1_estateId_1_tenantId_1_createdAt_1',
    key: { clientId: 1, estateId: 1, tenantId: 1, createdAt: 1 },
  },
  {
    collection: 'tenantcreditmovements',
    name: 'idx_tenant_credit_mpesa_receipt',
    key: { mpesaTransactionId: 1 },
    partialFilterExpression: { mpesaTransactionId: { $type: 'objectId' } },
  },
  {
    collection: 'tenantcreditmovements',
    name: 'idx_tenant_credit_manual_receipt',
    key: { manualReceiptId: 1 },
    partialFilterExpression: { manualReceiptId: { $type: 'objectId' } },
  },
  {
    collection: 'tenantcreditmovements',
    name: 'idx_tenant_credit_bank_receipt',
    key: { bankTransactionId: 1 },
    partialFilterExpression: { bankTransactionId: { $type: 'objectId' } },
  },
]);

function matches(indexes, spec) {
  return indexes.some((index) => index.name === spec.name
    && JSON.stringify(index.key) === JSON.stringify(spec.key)
    && index.unique !== true
    && Boolean(index.sparse) === Boolean(spec.sparse)
    && JSON.stringify(index.partialFilterExpression || null) === JSON.stringify(spec.partialFilterExpression || null));
}

export async function inspectPaymentReceiptReadModelIndexes() {
  const report = { aligned: false, collections: {}, missing: [] };
  const db = mongoose.connection?.db;
  if (!db) {
    report.reason = 'no_database_connection';
    return report;
  }
  for (const spec of REQUIRED) {
    let indexes = [];
    try {
      indexes = await db.collection(spec.collection).indexes();
    } catch {
      indexes = [];
    }
    report.collections[spec.collection] = indexes;
    if (!matches(indexes, spec)) report.missing.push(spec.name);
  }
  report.aligned = report.missing.length === 0;
  return report;
}
