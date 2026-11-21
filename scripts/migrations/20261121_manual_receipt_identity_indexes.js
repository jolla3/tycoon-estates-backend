/**
 * ManualReceipt identity indexes for ordinary manual payment capture.
 *
 * Creates:
 *   - uniq_client_manual_receipt_idempotency  { clientId: 1, idempotencyKey: 1 } unique
 *   - uniq_client_manual_receipt_reference    { clientId: 1, paymentReference: 1 } unique
 *     partial: paymentReference is non-empty string
 *
 * Default: dry-run. --execute requires G5_/G3_ SAFE_DB_ALLOWLIST, migration target DB,
 * and host allowlist (see lib/g5MigrationGuard.js). Not run against production by this task.
 *
 * Runtime readiness (manualReceiptIndexReadiness.assertManualReceiptIndexesAligned)
 * remains the gate for recordManual — this migration only installs the indexes.
 */
import { runIndexMigration, dupGroups } from './lib/g5MigrationGuard.js';
import { MANUAL_RECEIPT_INDEXES } from '../../src/models/ManualReceipt.js';
import { inspectManualReceiptIndexes } from '../../src/utils/manualReceiptIndexReadiness.js';

const IDEMP = MANUAL_RECEIPT_INDEXES.IDEMPOTENCY;
const REF = MANUAL_RECEIPT_INDEXES.REFERENCE;

// MongoDB unique indexes are collection-scoped. During the transition from
// legacy MANUAL Payment documents to ManualReceipt, explicitly reject any
// client/reference pair present in both collections before installing the
// new receipt indexes.
async function duplicateReferencesAcrossLegacyAndCanonicalCollections(db) {
  return db.collection('payments').aggregate([
    {
      $match: {
        origin: 'MANUAL',
        paymentReference: { $type: 'string', $gt: '' },
      },
    },
    {
      $project: {
        clientId: 1,
        paymentReference: 1,
        source: { $literal: 'payments' },
      },
    },
    {
      $unionWith: {
        coll: 'manualreceipts',
        pipeline: [
          { $match: { paymentReference: { $type: 'string', $gt: '' } } },
          {
            $project: {
              clientId: 1,
              paymentReference: 1,
              source: { $literal: 'manualreceipts' },
            },
          },
        ],
      },
    },
    {
      $group: {
        _id: { clientId: '$clientId', paymentReference: '$paymentReference' },
        count: { $sum: 1 },
        sources: { $addToSet: '$source' },
      },
    },
    { $match: { sources: { $all: ['payments', 'manualreceipts'] } } },
    { $limit: 30 },
  ], { allowDiskUse: true }).toArray();
}

export const config = {
  title: 'manual_receipt_identity_indexes',
  creates: [
    {
      collection: 'manualreceipts',
      name: IDEMP.name,
      key: { ...IDEMP.key },
      unique: true,
    },
    {
      collection: 'manualreceipts',
      name: REF.name,
      key: { ...REF.key },
      unique: true,
      partialFilterExpression: { ...REF.partialFilterExpression },
    },
  ],
  drops: [],
  preflight: async (db) => [
    {
      check: 'duplicate_manual_receipt_idempotency',
      samples: await dupGroups(
        db,
        'manualreceipts',
        { idempotencyKey: { $type: 'string', $gt: '' } },
        { c: '$clientId', k: '$idempotencyKey' }
      ),
    },
    {
      check: 'duplicate_manual_receipt_reference',
      samples: await dupGroups(
        db,
        'manualreceipts',
        { paymentReference: { $type: 'string', $gt: '' } },
        { c: '$clientId', r: '$paymentReference' }
      ),
    },
    {
      check: 'manual_reference_overlap_with_legacy_payments',
      samples: await duplicateReferencesAcrossLegacyAndCanonicalCollections(db),
    },
  ],
  verify: async (db) => {
    // Prefer the same readiness helper the application uses at runtime.
    // inspectManualReceiptIndexes reads mongoose.connection.db which is active here.
    const report = await inspectManualReceiptIndexes();
    if (report.aligned) return [];
    return [report.reason || 'ManualReceipt identity indexes not aligned after migration'];
  },
};

if (import.meta.url === `file://${process.argv[1]}`) {
  runIndexMigration(config).catch((e) => {
    console.error(e.message);
    process.exitCode = 1;
  });
}
