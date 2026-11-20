import { describe, test, expect } from '@jest/globals';
import { receiptScopeClause } from '../../../src/services/mpesaTransaction.service.js';
import { toMpesaTransactionDTO } from '../../../src/utils/mpesaTransactionDto.js';
import { buildPlan, analyzeIntegrity, indexPresent, INDEX_SPECS } from '../../../scripts/migrations/20261119_g54_mpesa_shared_merchant.js';
import { assertSafeTarget } from '../../../scripts/migrations/20261119_g54_mpesa_shared_merchant.js';

describe('receipt scope', () => {
  test('client-wide scope adds no estate predicate (unallocated visible)', () => {
    expect(receiptScopeClause(null)).toBeNull();
  });
  test('restricted scope is allocation/attribution only, never merchant membership', () => {
    const clause = receiptScopeClause('e1');
    expect(JSON.stringify(clause)).not.toMatch(/merchantProfileId/);
    expect(clause).toEqual({ $or: [{ allocatedEstateId: { $in: ['e1'] } }, { attributedEstateId: { $in: ['e1'] } }] });
    expect(receiptScopeClause(['e1', 'e2']).$or[0].allocatedEstateId.$in).toEqual(['e1', 'e2']);
  });
  test('DTO exposes allocation state and nothing sensitive; unallocated != posted', () => {
    const dto = toMpesaTransactionDTO({
      _id: 'r', businessShortCode: '1', receiptNumber: 'X', amountCents: 1, transactionAt: new Date(),
      verificationState: 'UNVERIFIED', claimState: 'UNCLAIMED', postingState: 'NOT_POSTED',
      allocationReferenceId: 'ref', allocatedTenantId: 'tenant', postingLeaseToken: 's',
    });
    expect(dto.allocationState).toBe('UNALLOCATED');
    expect(dto.postingState).toBe('NOT_POSTED');
    expect(dto).not.toHaveProperty('allocationReferenceId');
    expect(dto).not.toHaveProperty('allocatedTenantId');
    expect(dto).not.toHaveProperty('postingLeaseToken');
  });
});

describe('G5.4 migration planning', () => {
  const none = Object.fromEntries(INDEX_SPECS.map((s) => [s.name, false]));
  test('collisions block backfill and index creation (never auto-merge)', () => {
    const analysis = analyzeIntegrity({ collisions: [{ _id: { provider: 'DARAJA', businessShortCode: '1' }, n: 2, clients: ['a', 'b'] }] });
    const plan = buildPlan({ analysis, indexesBySpec: none, execute: true });
    expect(plan.blocked).toBe(true);
    expect(plan.backfillMappings).toBe(0);
    expect(plan.indexes.every((i) => i.state === 'blocked')).toBe(true);
  });
  test('dry run only reports; execute reports will_create; present indexes are idempotent', () => {
    const analysis = analyzeIntegrity({
      profiles: [{ _id: 'p1', clientId: 'c', estateId: 'e1' }, { _id: 'p2', clientId: 'c', estateId: 'e2' }],
      estates: [{ _id: 'e1', clientId: 'c' }, { _id: 'e2', clientId: 'c' }],
    });
    const dry = buildPlan({ analysis, indexesBySpec: none, execute: false });
    expect(dry.indexes.every((i) => i.state === 'dry_run_would_create')).toBe(true);
    expect(dry.backfillMappings).toBe(2);
    const done = buildPlan({ analysis: analyzeIntegrity({}), indexesBySpec: Object.fromEntries(INDEX_SPECS.map((s) => [s.name, true])), execute: true });
    expect(done.indexes.every((i) => i.state === 'already_present')).toBe(true);
  });
  test('indexPresent requires the partial filter for the active-tenancy index', () => {
    const spec = INDEX_SPECS.find((s) => s.name === 'uniq_mpesa_ref_active_tenancy');
    expect(indexPresent([{ key: spec.key, name: spec.name, unique: true }], spec)).toBe(false);
    expect(indexPresent([{ key: spec.key, name: spec.name, unique: true, partialFilterExpression: { status: 'ACTIVE' } }], spec)).toBe(true);
  });
  test('refuses production-like targets and unallowlisted execute', () => {
    expect(() => assertSafeTarget('mongodb://127.0.0.1:27017/tycoon_production', false)).toThrow(/unsafe database name/);
    expect(() => assertSafeTarget('mongodb://127.0.0.1:27017/tycoon_test', true)).toThrow(/Refusing --execute/);
  });
});
