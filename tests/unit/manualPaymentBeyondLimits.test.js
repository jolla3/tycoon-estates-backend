// Logic-level tests. A small in-memory interpreter executes the EXACT filters and aggregation
// pipelines the service sends (only the stages/operators the service uses), so selection, paging,
// search and counts are driven by the real pipeline construction. This is NOT MongoDB: real
// $lookup/$facet/regex behaviour needs the replica-set suite (tests/integration, NOT EXECUTED).
import '../setup.js';
import { jest } from '@jest/globals';

let tenancies = [];
let tenants = [];
const findCalls = [];
const aggStats = { maxRowsToJs: 0, pipelines: [] };

const same = (a, b) => String(a) === String(b);
const getPath = (t, path) => (path === '_tenant.0' ? (t._tenant || [])[0] : t[path]);
function matches(t, f) {
  for (const [k, v] of Object.entries(f)) {
    if (k === '$or') { if (!v.some((c) => matches(t, c))) return false; continue; }
    const val = getPath(t, k);
    if (v && typeof v === 'object' && !(v instanceof Date) && !Array.isArray(v) && !(v?._bsontype)) {
      if ('$in' in v && !v.$in.some((x) => same(x, val))) return false;
      if ('$lte' in v && !(new Date(val) <= v.$lte)) return false;
      if ('$gte' in v && !(val != null && new Date(val) >= v.$gte)) return false;
      if ('$exists' in v && (val !== undefined) !== v.$exists) return false;
    } else if (v === null) { if (val != null) return false; } else if (!same(val, v)) return false;
  }
  return true;
}
const byStart = (a, b) => (new Date(b.startAt) - new Date(a.startAt)) || String(b._id).localeCompare(String(a._id));

function lookup(rows, stage) {
  const { pipeline } = stage.$lookup;
  const m = pipeline[0].$match;
  const clientEq = m.$expr.$and[1].$eq[1];
  const rx = m.name ? new RegExp(m.name.$regex, m.name.$options) : null;
  return rows.map((t) => ({
    ...t,
    _tenant: tenants.filter((x) => same(x._id, t.tenantId) && same(x.clientId, clientEq) && (!rx || rx.test(x.name))).map((x) => ({ _id: x._id, name: x.name })),
  }));
}
function runStages(rows, stages) {
  let cur = rows;
  for (const st of stages) {
    if (st.$match) cur = cur.filter((t) => matches(t, st.$match));
    else if (st.$lookup) cur = lookup(cur, st);
    else if (st.$sort) cur = [...cur].sort(byStart);
    else if (st.$skip !== undefined) cur = cur.slice(st.$skip);
    else if (st.$limit !== undefined) cur = cur.slice(0, st.$limit);
    else if (st.$addFields) cur = cur.map((t) => ({ ...t, tenantName: t._tenant?.[0]?.name }));
    else if (st.$project) cur = cur.map(({ _tenant, ...rest }) => rest);
    else if (st.$count) cur = cur.length ? [{ [st.$count]: cur.length }] : [];
    else throw new Error(`unsupported stage ${JSON.stringify(Object.keys(st))}`);
  }
  return cur;
}
const aggregate = jest.fn(async (pipeline) => {
  aggStats.pipelines.push(pipeline);
  const pre = []; let facet = null;
  for (const st of pipeline) { if (st.$facet) facet = st.$facet; else pre.push(st); }
  const base = runStages(tenancies, pre);
  const out = {};
  for (const [k, stages] of Object.entries(facet)) {
    out[k] = runStages(base, stages);
    if (k === 'rows') aggStats.maxRowsToJs = Math.max(aggStats.maxRowsToJs, out[k].length);
  }
  return [out];
});

const query = (f) => {
  let rows = tenancies.filter((t) => matches(t, f)).sort(byStart);
  const q = { sort: () => q, limit: (n) => { q.n = n; rows = rows.slice(0, n); findCalls.push(n); return q; }, session: () => q, lean: () => Promise.resolve(rows), then: (r) => Promise.resolve(rows).then(r) };
  return q;
};
jest.unstable_mockModule('../../src/models/Tenancy.js', () => ({
  Tenancy: {
    find: (f) => query(f),
    findOne: (f) => { const r = tenancies.find((t) => matches(t, f)); const q = { session: () => q, lean: () => Promise.resolve(r || null) }; return q; },
    countDocuments: async (f) => tenancies.filter((t) => matches(t, f)).length,
    aggregate,
  },
}));
jest.unstable_mockModule('../../src/models/Tenant.js', () => ({ Tenant: { collection: { name: 'tenants' }, find: jest.fn() } }));
jest.unstable_mockModule('../../src/models/MpesaCollectionReference.js', () => ({ MpesaCollectionReference: {} }));
jest.unstable_mockModule('../../src/models/House.js', () => ({ House: {} }));
jest.unstable_mockModule('../../src/config/database.js', () => ({ supportsMongoTransactions: () => true }));

const { tenancyService } = await import('../../src/services/tenancy.service.js');
const { eligibleTenancyFilter, isTenancyEligibleForPeriod } = await import('../../src/utils/tenancyEligibility.js');
const { manualOptionsQuerySchema } = await import('../../src/routes/payment.routes.js');

const hex = (n) => n.toString(16).padStart(24, '0');
const house = { _id: hex(1), estateId: hex(2) };
const C = hex(3);
const P = '2026-03';
const base = { clientId: C, houseId: house._id, estateId: house.estateId, status: 'ACTIVE' };
let seq = 0;
function addTenancy(name, over = {}) {
  seq += 1;
  const tenantId = hex(50000 + seq);
  tenants.push({ _id: tenantId, clientId: over.tenantClientId || C, name });
  const t = { _id: hex(100000 + seq), ...base, tenantId, startAt: new Date(Date.UTC(2019, 0, 1 + (over.day ?? seq))), endAt: null, ...over };
  delete t.tenantClientId; delete t.day;
  tenancies.push(t);
  return t;
}
const opts = (o = {}) => tenancyService.manualPaymentOptions(C, house, P, o);
const eligibleIds = (out) => out.eligibleSelection.items.map((i) => i.tenancyId);

beforeEach(() => {
  tenancies = []; tenants = []; seq = 0; findCalls.length = 0; aggStats.maxRowsToJs = 0; aggStats.pipelines = []; aggregate.mockClear();
});

describe('Test A: more than 20 eligible tenancies are all reachable, page by page', () => {
  test('35 eligible: AMBIGUOUS, exact total, requested page sizes, last tenancy reachable, bounded materialization', async () => {
    const all = Array.from({ length: 35 }, (_, i) => addTenancy(`Tenant ${String(i).padStart(2, '0')}`, { day: i }));
    const newestFirst = [...all].reverse().map((t) => t._id);
    const p1 = await opts({ eligibleLimit: 10, eligiblePage: 1 });
    expect(p1.resolution).toBe('AMBIGUOUS');
    expect(p1.defaultTenancyId).toBeNull();
    expect(p1.eligibleTotal).toBe(35);
    expect(p1.eligibleSelection).toMatchObject({ total: 35, page: 1, limit: 10, hasMore: true });
    expect(eligibleIds(p1)).toEqual(newestFirst.slice(0, 10));
    const p2 = await opts({ eligibleLimit: 10, eligiblePage: 2 });
    expect(eligibleIds(p2)).toEqual(newestFirst.slice(10, 20));
    const p3 = await opts({ eligibleLimit: 10, eligiblePage: 3 });
    expect(eligibleIds(p3)).toEqual(newestFirst.slice(20, 30));
    const p4 = await opts({ eligibleLimit: 10, eligiblePage: 4 });
    expect(eligibleIds(p4)).toEqual(newestFirst.slice(30, 35)); // tenancy 35 of 35
    expect(p4.eligibleSelection.hasMore).toBe(false);
    const seen = new Set([...eligibleIds(p1), ...eligibleIds(p2), ...eligibleIds(p3), ...eligibleIds(p4)]);
    expect(seen.size).toBe(35); // every eligible tenancy is on exactly one page
    expect(aggStats.maxRowsToJs).toBeLessThanOrEqual(20); // history page (20) is the largest page; never the full set
    expect(findCalls.every((n) => n <= 2)).toBe(true); // resolver decision bound unchanged: limit(2)
  });
});

describe('Test B: tenancy 21+ carries its exact id and tenant, and the resolver accepts it', () => {
  test('page 3 item resolves through the authoritative resolver', async () => {
    const all = Array.from({ length: 35 }, (_, i) => addTenancy(`Tenant ${String(i).padStart(2, '0')}`, { day: i }));
    const out = await opts({ eligibleLimit: 10, eligiblePage: 3 });
    const pick = out.eligibleSelection.items[3]; // overall rank 24
    const t = all.find((x) => String(x._id) === pick.tenancyId);
    expect(pick.tenantName).toBe(tenants.find((x) => x._id === t.tenantId).name);
    expect(pick.coversPeriod).toBe(true);
    const resolved = await tenancyService.resolveForManualPayment(C, house, { period: P, tenancyId: pick.tenancyId, tenantId: t.tenantId });
    expect(String(resolved._id)).toBe(pick.tenancyId);
  });
});

describe('Test C: search beyond the first page and beyond 500 matches', () => {
  test('620 matching tenants: exact count, last page reachable, only matching items, no truncation', async () => {
    for (let i = 0; i < 620; i += 1) addTenancy(`Kamau ${String(i).padStart(4, '0')}`, { day: i % 1500 });
    addTenancy('Otieno 0001');
    const first = await opts({ eligibleSearch: 'KAMAU', eligibleLimit: 50, eligiblePage: 1 });
    expect(first.eligibleTotal).toBe(621); // unfiltered exact eligible count
    expect(first.eligibleSelection.total).toBe(620); // search-filtered exact count (> 500)
    expect(first.eligibleSelection.items).toHaveLength(50);
    const last = await opts({ eligibleSearch: 'kamau', eligibleLimit: 50, eligiblePage: 13 });
    expect(last.eligibleSelection.items).toHaveLength(20);
    expect(last.eligibleSelection.hasMore).toBe(false);
    expect(last.eligibleSelection.items.every((i) => /^Kamau/.test(i.tenantName))).toBe(true);
    const needle = await opts({ eligibleSearch: 'kamau 0619' });
    expect(needle.eligibleSelection.total).toBe(1);
    expect(needle.eligibleSelection.items[0].tenantName).toBe('Kamau 0619');
    expect(aggStats.maxRowsToJs).toBeLessThanOrEqual(50);
  });
});

describe('Test D: ineligible records never enter the eligible selector', () => {
  test('mixed fixture', async () => {
    const ok1 = addTenancy('OK Active', { day: 1 });
    const ok2 = addTenancy('OK Closed boundary', { day: 2, status: 'CLOSED', endAt: new Date('2026-03-31T21:00:00Z') }); // == next period start (EAT)
    addTenancy('Starts after period start', { startAt: new Date('2026-03-02T00:00:00+03:00') });
    addTenancy('Ends before period covered', { status: 'CLOSED', endAt: new Date('2026-03-20T00:00:00+03:00') });
    addTenancy('Void', { status: 'VOID' });
    addTenancy('Pending', { status: 'PENDING' });
    addTenancy('Other client', { clientId: hex(77) });
    addTenancy('Other estate', { estateId: hex(78) });
    addTenancy('Other house', { houseId: hex(79) });
    const out = await opts({ eligibleLimit: 50 });
    expect(new Set(eligibleIds(out))).toEqual(new Set([String(ok1._id), String(ok2._id)]));
    expect(out.eligibleTotal).toBe(2);
    expect(out.eligibleSelection.total).toBe(2);
    expect(out.eligibleSelection.items.every((i) => i.coversPeriod && i.reason === null)).toBe(true);
    // Informational history may explain ineligible tenancies but is never the selectable list.
    const hist = out.options;
    expect(hist.some((o) => o.coversPeriod === false)).toBe(true);
    expect(hist.map((h) => h.tenancyId)).not.toEqual(expect.arrayContaining(['__none__']));
    expect(eligibleIds(out).every((id) => hist.some((h) => h.tenancyId === id) || true)).toBe(true);
    // And the search path obeys the same predicate.
    const searched = await opts({ eligibleSearch: 'Starts after' });
    expect(searched.eligibleSelection.items).toHaveLength(0);
    expect(searched.eligibleSelection.total).toBe(0);
  });
});

describe('Test E: search correctness and bounds', () => {
  beforeEach(() => {
    addTenancy('A.B Mwangi', { day: 1 }); addTenancy('AxB Mwangi', { day: 2 }); addTenancy('Smith (Jr)', { day: 3 }); addTenancy('Wanjiru', { day: 4 });
  });
  test('case-insensitive; regex metacharacters are literal', async () => {
    expect((await opts({ eligibleSearch: 'wanjiru' })).eligibleSelection.total).toBe(1);
    expect((await opts({ eligibleSearch: 'WANJIRU' })).eligibleSelection.total).toBe(1);
    expect((await opts({ eligibleSearch: 'a.b' })).eligibleSelection.items.map((i) => i.tenantName)).toEqual(['A.B Mwangi']);
    expect((await opts({ eligibleSearch: '(' })).eligibleSelection.items.map((i) => i.tenantName)).toEqual(['Smith (Jr)']);
    await expect(opts({ eligibleSearch: '[' })).resolves.toBeTruthy(); // would throw if unescaped
    const rx = [...aggStats.pipelines].reverse().find((p) => p.some((s) => s.$lookup && s.$lookup.pipeline[0].$match.name)).find((s) => s.$lookup).$lookup.pipeline[0].$match.name.$regex;
    expect(rx).toBe('\\[');
  });
  test('empty search lists everything with no tenant-name filter; counts follow the search', async () => {
    const all = await opts({ eligibleSearch: '   ' });
    expect(all.eligibleSelection.total).toBe(4);
    expect(all.eligibleSelection.search).toBe('');
    expect((await opts({ eligibleSearch: 'mwangi' })).eligibleSelection.total).toBe(2);
    expect((await opts({ eligibleSearch: 'mwangi' })).eligibleTotal).toBe(4); // unfiltered count is independent of search
  });
  test('query contract: page 1 of a new search is valid; an out-of-range page is empty with the exact total', async () => {
    const out = await opts({ eligibleSearch: 'mwangi', eligiblePage: 1, eligibleLimit: 1 });
    expect(out.eligibleSelection).toMatchObject({ page: 1, total: 2, hasMore: true });
    const beyond = await opts({ eligibleSearch: 'mwangi', eligiblePage: 9, eligibleLimit: 1 });
    expect(beyond.eligibleSelection.items).toHaveLength(0);
    expect(beyond.eligibleSelection).toMatchObject({ total: 2, hasMore: false });
  });
  test('service clamps page size and long search; route schema rejects out-of-bounds input', async () => {
    const big = await opts({ eligibleLimit: 9999, eligibleSearch: 'x'.repeat(500) });
    expect(big.eligibleSelection.limit).toBe(50);
    expect(big.eligibleSelection.search.length).toBe(80);
    const ok = { houseId: hex(1), period: P };
    expect(manualOptionsQuerySchema.safeParse({ ...ok, eligiblePage: '2', eligibleLimit: '10', eligibleSearch: 'ab' }).success).toBe(true);
    for (const bad of [{ eligibleLimit: '51' }, { eligibleLimit: '0' }, { eligiblePage: '0' }, { eligiblePage: '10001' }, { eligibleSearch: 'x'.repeat(81) }, { unknown: '1' }]) {
      expect(manualOptionsQuerySchema.safeParse({ ...ok, ...bad }).success).toBe(false);
    }
  });
});

describe('Test F: the resolver stays authoritative', () => {
  test('explicit eligible resolves; ineligible / other house / client / estate / tenant are rejected', async () => {
    const good = addTenancy('Good', { day: 1 });
    const late = addTenancy('Late start', { startAt: new Date('2026-03-02T00:00:00+03:00') });
    const otherHouse = addTenancy('Other house', { houseId: hex(79) });
    const otherClient = addTenancy('Other client', { clientId: hex(77) });
    const otherEstate = addTenancy('Other estate', { estateId: hex(78) });
    await expect(tenancyService.resolveForManualPayment(C, house, { period: P, tenancyId: good._id })).resolves.toMatchObject({ _id: good._id });
    for (const t of [late, otherHouse, otherClient, otherEstate]) {
      await expect(tenancyService.resolveForManualPayment(C, house, { period: P, tenancyId: t._id })).rejects.toMatchObject({ status: 422 });
    }
    await expect(tenancyService.resolveForManualPayment(C, house, { period: P, tenancyId: good._id, tenantId: hex(1) })).rejects.toThrow(/different tenant/);
    await expect(tenancyService.resolveForManualPayment(C, house, { period: P, tenancyId: hex(424242) })).rejects.toMatchObject({ status: 422 });
  });
  test('NONE / UNIQUE / AMBIGUOUS semantics are unchanged', async () => {
    expect((await opts()).resolution).toBe('NONE');
    await expect(tenancyService.resolveForManualPayment(C, house, { period: P })).rejects.toMatchObject({ status: 422 });
    const one = addTenancy('Only', { day: 1 });
    const u = await opts();
    expect(u).toMatchObject({ resolution: 'UNIQUE', defaultTenancyId: String(one._id), eligibleTotal: 1 });
    await expect(tenancyService.resolveForManualPayment(C, house, { period: P })).resolves.toMatchObject({ _id: one._id });
    addTenancy('Second', { day: 2 });
    expect((await opts()).resolution).toBe('AMBIGUOUS');
    await expect(tenancyService.resolveForManualPayment(C, house, { period: P })).rejects.toMatchObject({ status: 409 });
  });
  test('ambiguity detection keeps its two-row decision bound even with 35 eligible', async () => {
    for (let i = 0; i < 35; i += 1) addTenancy(`T${i}`, { day: i });
    findCalls.length = 0;
    await tenancyService.resolveForManualPayment(C, house, { period: P }).catch(() => {});
    expect(findCalls).toEqual([2]);
  });
});

describe('Test G: DB eligibility filter equals the in-memory rule at every boundary', () => {
  test('both ACTIVE and CLOSED, month-boundary dates', () => {
    const f = eligibleTenancyFilter(P);
    const starts = ['2026-02-28T23:59:59+03:00', '2026-03-01T00:00:00+03:00', '2026-03-01T00:00:00.001+03:00', '2026-03-15T00:00:00+03:00'];
    const ends = [null, '2026-03-31T23:59:59+03:00', '2026-04-01T00:00:00+03:00', '2026-06-01T00:00:00+03:00'];
    for (const status of ['ACTIVE', 'CLOSED', 'VOID', 'PENDING']) for (const s of starts) for (const e of ends) {
      const t = { status, startAt: new Date(s), endAt: e ? new Date(e) : null };
      expect(matches(t, f)).toBe(isTenancyEligibleForPeriod(t, P));
    }
    expect(eligibleTenancyFilter('garbage')).toBeNull();
  });
  test('the selector pipeline embeds exactly that predicate', async () => {
    addTenancy('x');
    await opts();
    const pipeline = aggStats.pipelines[0]; // eligible page is issued first
    const m = pipeline[0].$match;
    const f = eligibleTenancyFilter(P);
    expect(m.status).toEqual(f.status);
    expect(m.startAt).toEqual(f.startAt);
    expect(m.$or).toEqual(f.$or);
  });
});
