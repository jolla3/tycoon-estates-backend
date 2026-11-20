import { describe, test, expect } from '@jest/globals';
import { analyzeIntegrity, buildPlan, INDEX_SPECS } from '../../../scripts/migrations/20261119_g54_mpesa_shared_merchant.js';

const none = Object.fromEntries(INDEX_SPECS.map((s) => [s.name, false]));
const codes = (a) => a.violations.map((v) => v.code);

describe('G5.4 migration preflight integrity (Profile.clientId === Mapping.clientId === Estate.clientId)', () => {
  const profiles = [{ _id: 'p1', clientId: 'c1', estateId: 'e1' }];

  test('safe legacy data is backfilled and not blocked', () => {
    const a = analyzeIntegrity({ profiles, estates: [{ _id: 'e1', clientId: 'c1' }] });
    expect(a.blocked).toBe(false);
    expect(a.backfill.map((p) => p._id)).toEqual(['p1']);
    expect(buildPlan({ analysis: a, indexesBySpec: none, execute: true }).backfillMappings).toBe(1);
  });

  test('already-mapped legacy profile is not backfilled again (idempotent)', () => {
    const a = analyzeIntegrity({
      profiles, estates: [{ _id: 'e1', clientId: 'c1' }],
      mappings: [{ _id: 'm1', merchantProfileId: 'p1', estateId: 'e1', clientId: 'c1' }],
    });
    expect(a.blocked).toBe(false);
    expect(a.backfill).toHaveLength(0);
  });

  test('legacy estate that does not exist blocks and is never backfilled', () => {
    const a = analyzeIntegrity({ profiles, estates: [] });
    expect(codes(a)).toContain('estate_missing');
    expect(a.backfill).toHaveLength(0);
    const plan = buildPlan({ analysis: a, indexesBySpec: none, execute: true });
    expect(plan.blocked).toBe(true);
    expect(plan.backfillMappings).toBe(0);
    expect(plan.indexes.every((i) => i.state === 'blocked')).toBe(true);
  });

  test('legacy estate owned by a different client blocks', () => {
    const a = analyzeIntegrity({ profiles, estates: [{ _id: 'e1', clientId: 'OTHER' }] });
    expect(codes(a)).toContain('estate_client_mismatch');
    expect(a.backfill).toHaveLength(0);
    expect(a.violations[0]).toMatchObject({ estateClientId: 'OTHER', expectedClientId: 'c1' });
  });

  test('existing mapping: missing estate, cross-client estate, client disagreement, missing profile', () => {
    const base = { profiles: [{ _id: 'p1', clientId: 'c1' }] };
    expect(codes(analyzeIntegrity({ ...base, mappings: [{ _id: 'm', merchantProfileId: 'p1', estateId: 'eX', clientId: 'c1' }], estates: [] })))
      .toContain('estate_missing');
    expect(codes(analyzeIntegrity({ ...base, mappings: [{ _id: 'm', merchantProfileId: 'p1', estateId: 'e1', clientId: 'c1' }], estates: [{ _id: 'e1', clientId: 'c2' }] })))
      .toContain('estate_client_mismatch');
    expect(codes(analyzeIntegrity({ ...base, mappings: [{ _id: 'm', merchantProfileId: 'p1', estateId: 'e1', clientId: 'c2' }], estates: [{ _id: 'e1', clientId: 'c1' }] })))
      .toContain('mapping_client_mismatch');
    expect(codes(analyzeIntegrity({ ...base, mappings: [{ _id: 'm', merchantProfileId: 'GONE', estateId: 'e1', clientId: 'c1' }], estates: [{ _id: 'e1', clientId: 'c1' }] })))
      .toContain('mapping_profile_missing');
  });

  test('one bad record blocks execution of an otherwise valid backfill', () => {
    const a = analyzeIntegrity({
      profiles: [{ _id: 'p1', clientId: 'c1', estateId: 'e1' }, { _id: 'p2', clientId: 'c1', estateId: 'e2' }],
      estates: [{ _id: 'e1', clientId: 'c1' }, { _id: 'e2', clientId: 'c9' }],
    });
    expect(a.blocked).toBe(true);
    expect(buildPlan({ analysis: a, indexesBySpec: none, execute: true }).backfillMappings).toBe(0);
  });

  test('duplicate mapping keys, duplicate reference keys, duplicate active tenancy refs, collisions all block', () => {
    const a = analyzeIntegrity({
      mappingDuplicates: [{ _id: { merchantProfileId: 'p1', estateId: 'e1' }, n: 2 }],
      referenceDuplicates: [{ _id: { merchantProfileId: 'p1', reference: 'TAAAAAAAAA' }, n: 2 }],
      activeTenancyDuplicates: [{ _id: { merchantProfileId: 'p1', tenancyId: 't1' }, n: 2 }],
      collisions: [{ _id: { provider: 'DARAJA', businessShortCode: '123' }, n: 2, clients: ['a'] }],
    });
    expect(codes(a).sort()).toEqual([
      'duplicate_active_tenancy_reference', 'duplicate_mapping_key', 'duplicate_reference_key', 'shortcode_collision',
    ]);
    expect(buildPlan({ analysis: a, indexesBySpec: none, execute: true }).violationCodes).toHaveLength(4);
  });

  test('references with a missing profile or client disagreement are reported', () => {
    const a = analyzeIntegrity({
      profiles: [{ _id: 'p1', clientId: 'c1' }],
      references: [
        { _id: 'r1', merchantProfileId: 'GONE', estateId: 'e1', clientId: 'c1' },
        { _id: 'r2', merchantProfileId: 'p1', estateId: 'e1', clientId: 'c2' },
      ],
      estates: [{ _id: 'e1', clientId: 'c1' }],
    });
    expect(codes(a)).toEqual(expect.arrayContaining(['reference_profile_missing', 'reference_client_mismatch']));
  });
});
