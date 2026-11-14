/**
 * G5.3 — Partial unique index on mpesaingestionevents.idempotencyKey (source-observation identity).
 * NOT canonical receipt identity (B01/B02 unresolved); no MpesaTransaction index is touched.
 * Default dry-run; --execute is guarded by the shared G5 allowlist guard. Never run at app startup.
 *
 * Preflight is read-only and BLOCKS (no cleanup is ever performed) when:
 *  - rows already carrying an idempotencyKey collide, or
 *  - legacy rows (no key) already collide on (provider, sourceChannel, businessShortCode, receiptNumber),
 *    because they would be ambiguous once keys are assigned. Resolve manually with the owner.
 * Legacy rows without a key are ignored by the partial index and are not modified.
 */
import { runIndexMigration, dupGroups } from './lib/g5MigrationGuard.js';
import { INBOX_IDEMPOTENCY_INDEX as I } from '../../src/utils/mpesaIndexReadiness.js';

export const config = {
  title: 'g5_inbox_idempotency_index',
  creates: [{
    collection: I.collection,
    name: I.name,
    key: I.key,
    unique: true,
    partialFilterExpression: I.partialFilterExpression,
  }],
  drops: [],
  preflight: async (db) => [
    {
      check: 'dup_inbox_idempotency_key',
      samples: await dupGroups(db, I.collection, { idempotencyKey: { $type: 'string' } }, '$idempotencyKey'),
    },
    {
      check: 'legacy_inbox_observation_collisions',
      samples: await dupGroups(
        db,
        I.collection,
        { idempotencyKey: { $not: { $type: 'string' } }, receiptNumber: { $type: 'string' } },
        { p: '$provider', s: '$sourceChannel', b: '$businessShortCode', r: '$receiptNumber' }
      ),
    },
  ],
};

if (import.meta.url === `file://${process.argv[1]}`) {
  runIndexMigration(config).catch((e) => { console.error(e.message); process.exitCode = 1; });
}
