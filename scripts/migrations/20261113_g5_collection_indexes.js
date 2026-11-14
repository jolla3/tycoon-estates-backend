/**
 * G5 — Unique identities for submission links, SMS submissions and Tenant credit movements.
 * Default dry-run; --execute guarded. Never auto-created at application startup.
 */
import { runIndexMigration, dupGroups } from './lib/g5MigrationGuard.js';
import { SUBMISSION_LINK_INDEXES as L } from '../../src/models/MpesaSubmissionLink.js';
import { SMS_SUBMISSION_INDEXES as S } from '../../src/models/MpesaSmsSubmission.js';
import { CREDIT_MOVEMENT_INDEXES as C } from '../../src/models/TenantCreditMovement.js';

const mk = (collection, s) => ({
  collection, name: s.name, key: s.key, unique: true,
  ...(s.partialFilterExpression ? { partialFilterExpression: s.partialFilterExpression } : {}),
});

export const config = {
  title: 'g5_collection_indexes',
  creates: [
    mk('mpesasubmissionlinks', L.IDENTITY), mk('mpesasubmissionlinks', L.DIGEST),
    mk('mpesasmssubmissions', S.EVIDENCE), mk('tenantcreditmovements', C.IDEMPOTENCY),
  ],
  drops: [],
  preflight: async (db) => [
    { check: 'dup_link_tenant', samples: await dupGroups(db, 'mpesasubmissionlinks', {}, { c: '$clientId', e: '$estateId', t: '$tenantId' }) },
    { check: 'dup_link_digest', samples: await dupGroups(db, 'mpesasubmissionlinks', { tokenDigest: { $type: 'string' } }, '$tokenDigest') },
    { check: 'dup_submission_evidence', samples: await dupGroups(db, 'mpesasmssubmissions', {}, { c: '$clientId', e: '$estateId', t: '$tenantId', d: '$evidenceDigest' }) },
    { check: 'dup_credit_key', samples: await dupGroups(db, 'tenantcreditmovements', {}, { c: '$clientId', e: '$estateId', t: '$tenantId', k: '$idempotencyKey' }) },
  ],
};

if (import.meta.url === `file://${process.argv[1]}`) {
  runIndexMigration(config).catch((e) => { console.error(e.message); process.exitCode = 1; });
}
