// Logic-level: a tiny in-memory evaluator executes the EXACT filters the service sends, so we can
// prove no candidate cap exists (1,000 tenancies, oldest one is the only eligible). Real
// $lookup/$facet behaviour needs MongoDB: see tests/integration/g54.sharedPaybill.test.js (NOT EXECUTED).
import '../setup.js';
import { jest } from '@jest/globals';

let tenancies = [];
const aggregate = jest.fn();
const tenantFind = jest.fn();

const same = (a, b) => String(a) === String(b);
function matches(t, f) {
  for (const [k, v] of Object.entries(f)) {
    if (k === '$or') { if (!v.some((c) => matches(t, c))) return false; continue; }
    const val = t[k];
    if (v && typeof v === 'object' && !(v instanceof Date) && !Array.isArray(v)) {
      if ('$in' in v && !v.$in.some((x) => same(x, val))) return false;
      if ('$lte' in v && !(new Date(val) <= v.$lte)) return false;
      if ('$gte' in v && !(val != null && new Date(val) >= v.$gte)) return false;
    } else if (v === null) { if (val != null) return false; } else if (!same(val, v)) return false;
  }
  return true;
}
const query = (f) => {
  let rows = tenancies.filter((t) => matches(t, f)).sort((a, b) => new Date(b.startAt) - new Date(a.startAt));
  const q = { sort: () => q, limit: (n) => { rows = rows.slice(0, n); return q; }, session: () => q, lean: () => Promise.resolve(rows), then: (r) => Promise.resolve(rows).then(r) };
  return q;
};
jest.unstable_mockModule('../../src/models/Tenancy.js', () => ({
  Tenancy: { find: (f) => query(f), countDocuments: async (f) => tenancies.filter((t) => matches(t, f)).length, aggregate },
}));
jest.unstable_mockModule('../../src/models/Tenant.js', () => ({
  Tenant: { collection: { name: 'tenants' }, find: tenantFind },
}));
jest.unstable_mockModule('../../src/models/MpesaCollectionReference.js', () => ({ MpesaCollectionReference: {} }));
jest.unstable_mockModule('../../src/models/House.js', () => ({ House: {} }));
jest.unstable_mockModule('../../src/config/database.js', () => ({ supportsMongoTransactions: () => true }));

const { tenancyService } = await import('../../src/services/tenancy.service.js');

const hex = (n) => n.toString(16).padStart(24, '0');
const house = { _id: hex(1), estateId: hex(2) };
const C = hex(3);
const mk = (i, over) => ({ _id: hex(1000 + i), clientId: C, houseId: house._id, estateId: house.estateId, tenantId: hex(5000 + i), status: 'CLOSED', ...over });

beforeEach(() => {
  aggregate.mockReset();
  aggregate.mockResolvedValue([{ rows: [], total: [] }]);
  tenantFind.mockReset();
  tenantFind.mockReturnValue({ select: () => ({ lean: async () => [] }) });
});

describe('manual-payment resolution has no candidate cap', () => {
  // 1,000 short tenancies in 2025 (cannot cover 2020-03) ... plus one old eligible tenancy.
  const build = () => {
    const many = Array.from({ length: 1000 }, (_, i) => mk(i, { startAt: new Date(Date.UTC(2025, 0, 1 + (i % 28))), endAt: new Date(Date.UTC(2025, 0, 2 + (i % 28))) }));
    const old = mk(5000, { startAt: new Date(Date.UTC(2019, 0, 1)), endAt: new Date(Date.UTC(2021, 0, 1)) });
    return [...many, old]; // eligible one is last/oldest, i.e. beyond any latest-200 window
  };

  test('options and resolver both find the old eligible tenancy beyond 200 candidates', async () => {
    tenancies = build();
    const out = await tenancyService.manualPaymentOptions(C, house, '2020-03', {});
    expect(out.resolution).toBe('UNIQUE');
    expect(out.defaultTenancyId).toBe(hex(6000));
    expect(out.eligibleOptions.map((o) => o.tenancyId)).toEqual([hex(6000)]);
    expect(out.eligibleTotal).toBe(1);
    const t = await tenancyService.resolveForManualPayment(C, house, { period: '2020-03' });
    expect(String(t._id)).toBe(out.defaultTenancyId);
  });

  test('ambiguity is detected even when the second eligible tenancy is far down the list', async () => {
    tenancies = [...build(), mk(5001, { startAt: new Date(Date.UTC(2018, 5, 1)), endAt: null, status: 'ACTIVE' })];
    const out = await tenancyService.manualPaymentOptions(C, house, '2020-03', {});
    expect(out.resolution).toBe('AMBIGUOUS');
    expect(out.eligibleTotal).toBe(2);
    await expect(tenancyService.resolveForManualPayment(C, house, { period: '2020-03' })).rejects.toMatchObject({ status: 409 });
  });

  test('NONE when nothing covers the period; tenantId mismatch is distinguished from none', async () => {
    tenancies = build();
    const o = await tenancyService.manualPaymentOptions(C, house, '2023-06', {});
    expect(o.resolution).toBe('NONE');
    await expect(tenancyService.resolveForManualPayment(C, house, { period: '2023-06' })).rejects.toMatchObject({ status: 422 });
    await expect(tenancyService.resolveForManualPayment(C, house, { period: '2020-03', tenantId: hex(9) }))
      .rejects.toThrow(/tenantId does not match/);
  });

  test('eligibleOptions display is bounded but the total stays exact', async () => {
    tenancies = Array.from({ length: 35 }, (_, i) => mk(i, { startAt: new Date(Date.UTC(2019, 0, 1)), endAt: null, status: 'ACTIVE' }));
    const o = await tenancyService.manualPaymentOptions(C, house, '2020-03', {});
    expect(o.eligibleOptions).toHaveLength(20);
    expect(o.eligibleTotal).toBe(35);
    expect(o.resolution).toBe('AMBIGUOUS');
  });
});

describe('tenant-name search is joined in the database, not truncated at 500', () => {
  test('pipeline uses $lookup + $facet, scoped to client/estate/house, with no $limit before paging', async () => {
    tenancies = [];
    aggregate.mockResolvedValue([{ rows: [], total: [{ n: 750 }] }]);
    const out = await tenancyService.manualPaymentOptions(C, house, '2020-03', { search: 'a.b*', page: 2, limit: 20 });
    expect(out.total).toBe(750); // beyond 500 matches
    expect(out.hasMore).toBe(true);
    const pipeline = aggregate.mock.calls[0][0];
    const stages = pipeline.map((s) => Object.keys(s)[0]);
    expect(stages).toEqual(['$match', '$lookup', '$match', '$facet']);
    const rx = pipeline[2].$match._tenant.$elemMatch.name.$regex;
    expect(rx).toBe('a\\.b\\*'); // regex metacharacters escaped
    const facetRows = pipeline[3].$facet.rows;
    expect(facetRows.find((s) => s.$skip !== undefined).$skip).toBe(20);
    expect(JSON.stringify(pipeline)).not.toMatch(/"\$limit":500/);
    expect(String(pipeline[0].$match.clientId)).toBe(C);
    expect(String(pipeline[0].$match.houseId)).toBe(house._id);
  });

  test('no search term skips the tenant join entirely', async () => {
    tenancies = [];
    await tenancyService.manualPaymentOptions(C, house, '2020-03', {});
    expect(aggregate.mock.calls[0][0].map((s) => Object.keys(s)[0])).toEqual(['$match', '$facet']);
  });
});

describe('DB filter equals the in-memory eligibility rule at every boundary', () => {
  test('eligibleTenancyFilter agrees with isTenancyEligibleForPeriod', async () => {
    const { eligibleTenancyFilter, isTenancyEligibleForPeriod } = await import('../../src/utils/tenancyEligibility.js');
    const P = '2026-03';
    const f = eligibleTenancyFilter(P);
    const starts = ['2026-02-28T23:59:59+03:00', '2026-03-01T00:00:00+03:00', '2026-03-01T00:00:00.001+03:00', '2026-03-15T00:00:00+03:00'];
    const ends = [null, '2026-03-31T23:59:59+03:00', '2026-04-01T00:00:00+03:00', '2026-06-01T00:00:00+03:00'];
    for (const status of ['ACTIVE', 'CLOSED', 'VOID']) for (const s of starts) for (const e of ends) {
      const t = { status, startAt: new Date(s), endAt: e ? new Date(e) : null };
      expect(matches(t, f)).toBe(isTenancyEligibleForPeriod(t, P));
    }
    expect(eligibleTenancyFilter('garbage')).toBeNull();
  });
});
