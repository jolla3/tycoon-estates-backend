import '../setup.js';
import { jest } from '@jest/globals';
import mongoose from 'mongoose';
import { tenancyService } from '../../src/services/tenancy.service.js';
import { Tenancy } from '../../src/models/Tenancy.js';
import { Tenant } from '../../src/models/Tenant.js';
import { dateUtil } from '../../src/utils/date.js';
import { classifyTenanciesForPeriod, tenancyIneligibleReason, TENANCY_RESOLUTION } from '../../src/utils/manualPaymentTenancy.js';
import { isTenancyEligibleForPeriod } from '../../src/utils/tenancyEligibility.js';
import { manualPaymentSchema, manualOptionsQuerySchema, tenantContextQuerySchema } from '../../src/routes/payment.routes.js';

const oid = (n) => String(n).padStart(24, 'a');
const T = (o) => ({ status: 'CLOSED', tenantId: oid(1), ...o });
const PERIOD = '2026-03';

describe('classifyTenanciesForPeriod', () => {
  test('unique current tenancy', () => {
    const r = classifyTenanciesForPeriod([T({ status: 'ACTIVE', startAt: '2026-01-01', endAt: null })], PERIOD);
    expect(r.status).toBe(TENANCY_RESOLUTION.UNIQUE);
  });
  test('unique historic tenancy (closed after the period) is selected, not the current one', () => {
    const hist = T({ _id: 'h', startAt: '2025-01-01', endAt: '2026-05-01' });
    const cur = T({ _id: 'c', status: 'ACTIVE', tenantId: oid(2), startAt: '2026-05-01', endAt: null });
    const r = classifyTenanciesForPeriod([cur, hist], PERIOD);
    expect(r.status).toBe('UNIQUE');
    expect(r.tenancy._id).toBe('h');
  });
  test('none: mid-period move-in is not fully covered', () => {
    const r = classifyTenanciesForPeriod([T({ status: 'ACTIVE', startAt: '2026-03-15', endAt: null })], PERIOD);
    expect(r.status).toBe('NONE');
  });
  test('ambiguous when two tenancies fully cover the period', () => {
    const r = classifyTenanciesForPeriod([
      T({ _id: 'a', startAt: '2026-01-01', endAt: null, status: 'ACTIVE' }),
      T({ _id: 'b', tenantId: oid(2), startAt: '2026-01-01', endAt: '2026-06-01' }),
    ], PERIOD);
    expect(r.status).toBe('AMBIGUOUS');
  });
  test('tenantId narrows the candidates; a mismatched tenant yields NONE', () => {
    const list = [T({ startAt: '2026-01-01', endAt: null, status: 'ACTIVE' })];
    expect(classifyTenanciesForPeriod(list, PERIOD, { tenantId: oid(1) }).status).toBe('UNIQUE');
    expect(classifyTenanciesForPeriod(list, PERIOD, { tenantId: oid(9) }).status).toBe('NONE');
  });
  test('VOID tenancies are never eligible', () => {
    expect(classifyTenanciesForPeriod([T({ status: 'VOID', startAt: '2026-01-01', endAt: null })], PERIOD).status).toBe('NONE');
  });
  test('ended exactly at next period start still covers (endAt exclusive)', () => {
    expect(classifyTenanciesForPeriod([T({ startAt: '2026-01-01', endAt: '2026-04-01' })], PERIOD).status).toBe('UNIQUE');
  });
});

describe('tenancyIneligibleReason / isTenancyEligibleForPeriod share one boundary (Africa/Nairobi)', () => {
  const P = '2026-03'; // period starts 2026-03-01T00:00+03:00, next starts 2026-04-01T00:00+03:00
  const at = (iso, extra = {}) => ({ status: 'ACTIVE', tenantId: oid(1), startAt: iso, endAt: null, ...extra });

  test('starting exactly at the beginning of the period is eligible', () => {
    const t = at('2026-03-01T00:00:00+03:00');
    expect(isTenancyEligibleForPeriod(t, P)).toBe(true);
    expect(tenancyIneligibleReason(t, P)).toBeNull();
  });
  test('starting before the period is eligible', () => {
    expect(tenancyIneligibleReason(at('2026-02-28T23:59:59+03:00'), P)).toBeNull();
  });
  test('starting later on the first day is NOT eligible (one millisecond is enough)', () => {
    for (const iso of ['2026-03-01T00:00:00.001+03:00', '2026-03-01T08:00:00+03:00']) {
      const t = at(iso);
      expect(isTenancyEligibleForPeriod(t, P)).toBe(false);
      expect(tenancyIneligibleReason(t, P)).toMatch(/began after/);
    }
  });
  test('starting on the second day is NOT eligible', () => {
    const t = at('2026-03-02T00:00:00+03:00');
    expect(isTenancyEligibleForPeriod(t, P)).toBe(false);
    expect(tenancyIneligibleReason(t, P)).toMatch(/began after/);
  });
  test('ending before the next period begins is NOT eligible', () => {
    const t = at('2026-01-01T00:00:00+03:00', { status: 'CLOSED', endAt: '2026-03-31T23:59:59+03:00' });
    expect(isTenancyEligibleForPeriod(t, P)).toBe(false);
    expect(tenancyIneligibleReason(t, P)).toMatch(/ended before/);
  });
  test('ending exactly when the next period begins is eligible (endAt exclusive)', () => {
    const t = at('2026-01-01T00:00:00+03:00', { status: 'CLOSED', endAt: '2026-04-01T00:00:00+03:00' });
    expect(isTenancyEligibleForPeriod(t, P)).toBe(true);
    expect(tenancyIneligibleReason(t, P)).toBeNull();
  });
  test('ACTIVE and CLOSED historical tenancies are both eligible when they cover the period', () => {
    expect(tenancyIneligibleReason(at('2025-01-01T00:00:00+03:00'), P)).toBeNull();
    expect(tenancyIneligibleReason(at('2025-01-01T00:00:00+03:00', { status: 'CLOSED', endAt: '2026-09-01T00:00:00+03:00' }), P)).toBeNull();
  });
  test('VOID or unknown status is never eligible', () => {
    expect(tenancyIneligibleReason(at('2025-01-01T00:00:00+03:00', { status: 'VOID' }), P)).toMatch(/not active or closed/);
    expect(tenancyIneligibleReason(null, P)).not.toBeNull();
  });
  test('invalid dates and periods are ineligible with a specific reason', () => {
    expect(tenancyIneligibleReason(at('not-a-date'), P)).toMatch(/invalid start/);
    expect(tenancyIneligibleReason(at('2025-01-01T00:00:00+03:00', { status: 'CLOSED', endAt: 'garbage' }), P)).toMatch(/invalid end/);
    expect(tenancyIneligibleReason(at('2025-01-01T00:00:00+03:00'), '')).toMatch(/Invalid billing period/);
  });
  test('reason is null exactly when eligible, across boundary instants', () => {
    const instants = ['2026-02-28T20:59:59Z', '2026-02-28T21:00:00Z', '2026-02-28T21:00:00.001Z', '2026-03-01T21:00:00Z'];
    for (const s of instants) {
      for (const e of [null, '2026-03-31T20:59:59Z', '2026-03-31T21:00:00Z']) {
        const t = at(s, { endAt: e, status: e ? 'CLOSED' : 'ACTIVE' });
        expect(tenancyIneligibleReason(t, P) === null).toBe(isTenancyEligibleForPeriod(t, P));
      }
    }
  });
});

describe('manual payment request schemas', () => {
  const base = {
    houseId: oid(1), tenantId: oid(3), tenancyId: oid(2), amountCents: 1000,
    paymentDate: '2026-03-10', tenderMethod: 'CASH', idempotencyKey: 'key-12345678',
  };
  test('accepts an explicit tenant + house + tenancy submission', () => {
    const r = manualPaymentSchema.safeParse({ ...base, period: '2026-03' });
    expect(r.success).toBe(true);
    expect(r.data).toMatchObject({ tenantId: oid(3), houseId: oid(1), tenancyId: oid(2) });
  });
  test('tenantId and tenancyId are REQUIRED: no silent assignment to the current occupant', () => {
    const { tenantId, ...noTenant } = base;
    const { tenancyId, ...noTenancy } = base;
    expect(manualPaymentSchema.safeParse(noTenant).success).toBe(false);
    expect(manualPaymentSchema.safeParse(noTenancy).success).toBe(false);
  });
  test('rejects malformed ids and impossible periods', () => {
    expect(manualPaymentSchema.safeParse({ ...base, tenancyId: 'abc' }).success).toBe(false);
    expect(manualPaymentSchema.safeParse({ ...base, tenantId: 'abc' }).success).toBe(false);
    expect(manualPaymentSchema.safeParse({ ...base, houseId: 'abc' }).success).toBe(false);
    expect(manualPaymentSchema.safeParse({ ...base, period: '2026-13' }).success).toBe(false);
  });
  test('tenant-context query requires a tenantId and rejects unknown keys', () => {
    expect(tenantContextQuerySchema.safeParse({}).success).toBe(false);
    expect(tenantContextQuerySchema.safeParse({ tenantId: oid(3), paymentDate: '2026-03-10' }).success).toBe(true);
    expect(tenantContextQuerySchema.safeParse({ tenantId: oid(3), x: 1 }).success).toBe(false);
  });
  test('options query requires a houseId', () => {
    expect(manualOptionsQuerySchema.safeParse({}).success).toBe(false);
    expect(manualOptionsQuerySchema.safeParse({ houseId: oid(1), period: '2026-03' }).success).toBe(true);
  });
});

describe('manual-options pagination/search query', () => {
  const oidv = 'a'.repeat(24);
  test('accepts bounded page/limit/search and rejects unbounded values or unknown keys', () => {
    expect(manualOptionsQuerySchema.safeParse({ houseId: oidv, page: '2', limit: '50', search: 'wanjiru' }).success).toBe(true);
    expect(manualOptionsQuerySchema.safeParse({ houseId: oidv, limit: '500' }).success).toBe(false);
    expect(manualOptionsQuerySchema.safeParse({ houseId: oidv, page: '0' }).success).toBe(false);
    expect(manualOptionsQuerySchema.safeParse({ houseId: oidv, unexpected: 1 }).success).toBe(false);
  });
});

const resolveOid = () => new mongoose.Types.ObjectId();
const resolveClient = resolveOid();
const resolveEstate = resolveOid();
const resolveHouseId = resolveOid();
const resolveOldTenant = resolveOid();
const resolveCurrentTenant = resolveOid();
const resolveHouse = { _id: resolveHouseId, estateId: resolveEstate, houseNumber: '78' };
const resolveOldTenancy = {
  _id: resolveOid(), clientId: resolveClient, estateId: resolveEstate, houseId: resolveHouseId,
  tenantId: resolveOldTenant, status: 'CLOSED',
  startAt: new Date('2026-01-01T00:00:00+03:00'), endAt: new Date('2026-07-01T00:00:00+03:00'),
};
const resolveCurrentTenancy = {
  _id: resolveOid(), clientId: resolveClient, estateId: resolveEstate, houseId: resolveHouseId,
  tenantId: resolveCurrentTenant, status: 'ACTIVE',
  startAt: new Date('2026-07-01T00:00:00+03:00'), endAt: null,
};
const resolveChain = (result) => {
  const q = { session: () => q, lean: () => q,
    then: (resolve, reject) => Promise.resolve(result).then(resolve, reject) };
  return q;
};
function stubResolveRecords(rows, tenants = [
  { _id: resolveOldTenant, clientId: resolveClient, estateId: resolveEstate },
  { _id: resolveCurrentTenant, clientId: resolveClient, estateId: resolveEstate },
]) {
  const match = (query, row) => Object.entries(query).every(([key, value]) => String(row[key]) === String(value));
  jest.spyOn(Tenancy, 'findOne').mockImplementation((query) => resolveChain(rows.find((row) => match(query, row)) || null));
  jest.spyOn(Tenant, 'findOne').mockImplementation((query) => resolveChain(tenants.find((row) => match(query, row)) || null));
}
afterEach(() => jest.restoreAllMocks());

describe('resolveExplicitForManualPayment ownership', () => {
  const resolve = (ids, date) => tenancyService.resolveExplicitForManualPayment(
    resolveClient, resolveHouse, ids, dateUtil.parseNairobiDateOnly(date),
  );
  test('backdated payment goes to the former occupant, never the current one', async () => {
    stubResolveRecords([resolveOldTenancy, resolveCurrentTenancy]);
    const result = await resolve({ tenantId: resolveOldTenant, tenancyId: resolveOldTenancy._id }, '2026-03-10');
    expect(String(result.tenancy.tenantId)).toBe(String(resolveOldTenant));
    expect(String(result.tenant._id)).toBe(String(resolveOldTenant));
  });
  test('contradictory tenant and tenancy ids are rejected', async () => {
    stubResolveRecords([resolveOldTenancy, resolveCurrentTenancy]);
    await expect(resolve({ tenantId: resolveCurrentTenant, tenancyId: resolveOldTenancy._id }, '2026-03-10')).rejects.toMatchObject({ code: 'INVALID_REQUEST' });
    await expect(resolve({ tenantId: resolveOldTenant, tenancyId: resolveCurrentTenancy._id }, '2026-08-15')).rejects.toMatchObject({ code: 'INVALID_REQUEST' });
  });
  test('payment date must fall inside exact tenancy bounds', async () => {
    stubResolveRecords([resolveOldTenancy, resolveCurrentTenancy]);
    await expect(resolve({ tenantId: resolveOldTenant, tenancyId: resolveOldTenancy._id }, '2026-06-30')).resolves.toBeDefined();
    await expect(resolve({ tenantId: resolveOldTenant, tenancyId: resolveOldTenancy._id }, '2026-07-01')).rejects.toMatchObject({ code: 'INVALID_REQUEST' });
    await expect(resolve({ tenantId: resolveCurrentTenant, tenancyId: resolveCurrentTenancy._id }, '2026-07-01')).resolves.toBeDefined();
  });
  test('client, estate and house scope the identity query', async () => {
    const find = jest.spyOn(Tenancy, 'findOne').mockReturnValue(resolveChain(null));
    jest.spyOn(Tenant, 'findOne').mockReturnValue(resolveChain(null));
    await expect(resolve({ tenantId: resolveOldTenant, tenancyId: resolveOid() }, '2026-03-10')).rejects.toMatchObject({ code: 'INVALID_REQUEST' });
    expect(find.mock.calls[0][0]).toMatchObject({ clientId: resolveClient, estateId: resolveEstate, houseId: resolveHouseId });
  });
  test('a VOID tenancy is not selectable', async () => {
    stubResolveRecords([{ ...resolveOldTenancy, status: 'VOID' }]);
    await expect(resolve({ tenantId: resolveOldTenant, tenancyId: resolveOldTenancy._id }, '2026-03-10')).rejects.toMatchObject({ code: 'INVALID_REQUEST' });
  });
  test('missing explicit ids are rejected before database lookup', async () => {
    const find = jest.spyOn(Tenancy, 'findOne');
    await expect(resolve({ tenantId: resolveOldTenant }, '2026-03-10')).rejects.toMatchObject({ code: 'INVALID_REQUEST' });
    await expect(resolve({ tenancyId: resolveOldTenancy._id }, '2026-03-10')).rejects.toMatchObject({ code: 'INVALID_REQUEST' });
    expect(find).not.toHaveBeenCalled();
  });
});
