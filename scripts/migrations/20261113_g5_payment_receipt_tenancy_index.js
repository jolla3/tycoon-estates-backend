/**
 * G5 — Payment child identity for multi-Tenancy M-PESA receipts.
 * Drops any UNIQUE {mpesaReceiptId:1} index (blocks >1 child Payment per receipt),
 * creates unique partial {mpesaReceiptId, tenancyId} (origin MPESA) and
 * unique partial {clientId, creditApplicationKey}.
 * This is NOT the global canonical receipt identity (that stays on MpesaTransaction, B01/B02).
 * Default dry-run. --execute guarded. Not run against production by this task.
 */
import { runIndexMigration, dupGroups } from './lib/g5MigrationGuard.js';
import {
  PAYMENT_RECEIPT_TENANCY_INDEX as CHILD, PAYMENT_CREDIT_KEY_INDEX as CREDIT, evaluatePaymentIndexes,
} from '../../src/utils/paymentReceiptIndexReadiness.js';

const spec = (s) => ({ collection: 'payments', name: s.name, key: s.key, unique: true, partialFilterExpression: s.partialFilterExpression });

export const config = {
  title: 'g5_payment_receipt_tenancy_index',
  creates: [spec(CHILD), spec(CREDIT)],
  drops: [{ collection: 'payments', match: (i) => i.unique === true && JSON.stringify(i.key) === JSON.stringify({ mpesaReceiptId: 1 }) }],
  preflight: async (db) => [
    { check: 'duplicate_receipt_tenancy', samples: await dupGroups(db, 'payments', { origin: 'MPESA' }, { r: '$mpesaReceiptId', t: '$tenancyId' }) },
    { check: 'duplicate_credit_key', samples: await dupGroups(db, 'payments', { creditApplicationKey: { $type: 'string' } }, { c: '$clientId', k: '$creditApplicationKey' }) },
  ],
  verify: async (db) => {
    const r = evaluatePaymentIndexes(await db.collection('payments').indexes());
    return r.aligned ? [] : r.reasons;
  },
};

if (import.meta.url === `file://${process.argv[1]}`) {
  runIndexMigration(config).catch((e) => { console.error(e.message); process.exitCode = 1; });
}
