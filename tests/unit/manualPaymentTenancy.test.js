import '../setup.js';
import { classifyTenanciesForPeriod, tenancyIneligibleReason, TENANCY_RESOLUTION } from '../../src/utils/manualPaymentTenancy.js';
import { manualPaymentSchema, manualOptionsQuerySchema } from '../../src/routes/payment.routes.js';

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

describe('tenancyIneligibleReason', () => {
  test('null when eligible', () => {
    expect(tenancyIneligibleReason(T({ startAt: '2026-01-01', endAt: null }), PERIOD)).toBeNull();
  });
  test('explains a late start and an early end', () => {
    expect(tenancyIneligibleReason(T({ startAt: '2026-03-20', endAt: null }), PERIOD)).toMatch(/began after/);
    expect(tenancyIneligibleReason(T({ startAt: '2026-01-01', endAt: '2026-03-10' }), PERIOD)).toMatch(/ended before/);
  });
});

describe('manual payment request schemas', () => {
  const base = { houseId: oid(1), amountCents: 1000 };
  test('accepts tenancyId and period', () => {
    const r = manualPaymentSchema.safeParse({ ...base, tenancyId: oid(2), period: '2026-03' });
    expect(r.success).toBe(true);
    expect(r.data.tenancyId).toBe(oid(2));
  });
  test('rejects malformed ids and impossible periods', () => {
    expect(manualPaymentSchema.safeParse({ ...base, tenancyId: 'abc' }).success).toBe(false);
    expect(manualPaymentSchema.safeParse({ ...base, houseId: 'abc' }).success).toBe(false);
    expect(manualPaymentSchema.safeParse({ ...base, period: '2026-13' }).success).toBe(false);
  });
  test('options query requires a houseId', () => {
    expect(manualOptionsQuerySchema.safeParse({}).success).toBe(false);
    expect(manualOptionsQuerySchema.safeParse({ houseId: oid(1), period: '2026-03' }).success).toBe(true);
  });
});
