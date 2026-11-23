/**
 * G5 canonical Payments receipt read-model query indexes.
 * Dry-run by default. --execute is guarded by G5/G3 safe DB and host allowlists.
 * No unique indexes, drops, or data rewrites are performed here.
 */
import { runIndexMigration } from './lib/g5MigrationGuard.js';

const required = [
  {
    collection: 'manualreceipts',
    name: 'clientId_1_estateId_1_paymentDate_-1',
    key: { clientId: 1, estateId: 1, paymentDate: -1 },
    unique: false,
  },
  {
    collection: 'banktransactions',
    name: 'idx_bank_posted_receipts',
    key: { clientId: 1, estateId: 1, processingState: 1, eventType: 1, matchStatus: 1, transactionDate: -1 },
    unique: false,
  },
  {
    collection: 'payments',
    name: 'idx_payment_legacy_manual_list',
    key: { clientId: 1, estateId: 1, origin: 1, paymentDate: -1 },
    unique: false,
  },
  {
    collection: 'tenantcreditmovements',
    name: 'clientId_1_estateId_1_tenantId_1_createdAt_1',
    key: { clientId: 1, estateId: 1, tenantId: 1, createdAt: 1 },
    unique: false,
  },
  {
    collection: 'tenantcreditmovements',
    name: 'idx_tenant_credit_mpesa_receipt',
    key: { mpesaTransactionId: 1 },
    unique: false,
    partialFilterExpression: { mpesaTransactionId: { $type: 'objectId' } },
  },
  {
    collection: 'tenantcreditmovements',
    name: 'idx_tenant_credit_manual_receipt',
    key: { manualReceiptId: 1 },
    unique: false,
    partialFilterExpression: { manualReceiptId: { $type: 'objectId' } },
  },
  {
    collection: 'tenantcreditmovements',
    name: 'idx_tenant_credit_bank_receipt',
    key: { bankTransactionId: 1 },
    unique: false,
    partialFilterExpression: { bankTransactionId: { $type: 'objectId' } },
  },
];

async function installed(db, spec) {
  const indexes = await db.collection(spec.collection).indexes().catch(() => []);
  return indexes.some((index) => index.name === spec.name
    && JSON.stringify(index.key) === JSON.stringify(spec.key)
    && index.unique !== true
    && JSON.stringify(index.partialFilterExpression || null) === JSON.stringify(spec.partialFilterExpression || null));
}

const config = {
  title: 'g5_payment_receipt_read_model_indexes',
  creates: required,
  drops: [],
  preflight: async () => [],
  verify: async (db) => {
    const missing = [];
    for (const spec of required) {
      if (!(await installed(db, spec))) missing.push(`${spec.collection}.${spec.name}`);
    }
    return missing;
  },
};

if (import.meta.url === `file://${process.argv[1]}`) {
  runIndexMigration(config).catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
  });
}
