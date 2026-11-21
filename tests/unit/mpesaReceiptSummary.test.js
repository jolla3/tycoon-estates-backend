import '../setup.js';
import { jest } from '@jest/globals';

const { summarizeReceipts, classifyReceipt } = await import('../../src/services/mpesaReceiptSummary.js');

const r = (o) => ({ acceptedAmountCents: 1000, postingState: 'NOT_POSTED', verificationState: 'MATCHED', allocationState: 'UNALLOCATED', allocatedEstateId: null, attributedEstateId: null, paymentId: null, paymentIds: [], creditEarnedCents: 0, ...o });

describe('classifyReceipt precedence', () => {
  test('posted wins over everything, even a conflict flag', () => {
    expect(classifyReceipt(r({ postingState: 'POSTED', verificationState: 'CONFLICT' }))).toBe('POSTED');
  });
  test('conflict / manual review are quarantined, never rent', () => {
    expect(classifyReceipt(r({ verificationState: 'CONFLICT', allocatedEstateId: 'e1' }))).toBe('QUARANTINED');
    expect(classifyReceipt(r({ verificationState: 'MANUAL_REVIEW' }))).toBe('QUARANTINED');
  });
  test('no estate and unallocated is UNALLOCATED; any estate tie is ATTRIBUTED', () => {
    expect(classifyReceipt(r({}))).toBe('UNALLOCATED');
    expect(classifyReceipt(r({ allocatedEstateId: 'e1', allocationState: 'ALLOCATED_BY_REFERENCE' }))).toBe('ATTRIBUTED');
    expect(classifyReceipt(r({ attributedEstateId: 'e1' }))).toBe('ATTRIBUTED');
  });
  test('failed posting stays ATTRIBUTED (not counted as posted)', () => {
    expect(classifyReceipt(r({ attributedEstateId: 'e1', postingState: 'FAILED_RETRYABLE' }))).toBe('ATTRIBUTED');
  });
});

describe('summarizeReceipts', () => {
  const rows = [
    r({ acceptedAmountCents: 5000, postingState: 'POSTED', allocatedEstateId: 'e1', paymentId: 'p1', creditEarnedCents: 200 }),
    r({ acceptedAmountCents: 3000, postingState: 'POSTED', attributedEstateId: 'e2', paymentIds: ['p2', 'p3'] }),
    r({ acceptedAmountCents: 700, verificationState: 'CONFLICT', allocatedEstateId: 'e1' }),
    r({ acceptedAmountCents: 400 }),
    r({ acceptedAmountCents: 900, verificationState: 'UNVERIFIED', attributedEstateId: 'e1' }),
  ];
  const s = summarizeReceipts(rows);

  test('state buckets partition the observed total exactly (no double counting)', () => {
    const sum = Object.values(s.states).reduce((a, b) => ({ count: a.count + b.count, amountCents: a.amountCents + b.amountCents }), { count: 0, amountCents: 0 });
    expect(s.providerObserved).toEqual({ count: 5, amountCents: 10000 });
    expect(sum).toEqual(s.providerObserved);
    expect(s.states.POSTED).toEqual({ count: 2, amountCents: 8000 });
    expect(s.states.QUARANTINED).toEqual({ count: 1, amountCents: 700 });
    expect(s.states.UNALLOCATED).toEqual({ count: 1, amountCents: 400 });
    expect(s.states.ATTRIBUTED).toEqual({ count: 1, amountCents: 900 });
  });
  test('verification lens also sums to the same total', () => {
    const sum = Object.values(s.verification).reduce((a, b) => a + b.amountCents, 0);
    expect(sum).toBe(10000);
    expect(s.verification.UNVERIFIED.count).toBe(1);
  });
  test('posted payments are counted from the receipts, with multi-payment receipts', () => {
    expect(s.posted).toEqual({ receiptCount: 2, paymentCount: 3, amountCents: 8000, creditEarnedCents: 200 });
  });
  test('per-estate rows partition the total and keep the unattributed group', () => {
    const total = s.byEstate.reduce((a, e) => a + e.providerObserved.amountCents, 0);
    expect(total).toBe(10000);
    expect(s.byEstate.find((e) => e.estateId === null).providerObserved.amountCents).toBe(400);
    expect(s.byEstate.find((e) => e.estateId === 'e1').providerObserved.amountCents).toBe(5000 + 700 + 900);
  });
  test('empty window is zeros, not missing', () => {
    const e = summarizeReceipts([]);
    expect(e.providerObserved).toEqual({ count: 0, amountCents: 0 });
    expect(e.byEstate).toEqual([]);
  });
  test('bad amounts never produce NaN or negatives', () => {
    expect(summarizeReceipts([r({ acceptedAmountCents: -5 }), r({ acceptedAmountCents: undefined })]).providerObserved.amountCents).toBe(0);
  });
  test('output exposes no raw receipt fields', () => {
    const json = JSON.stringify(summarizeReceipts([r({ billRefNumber: 'SECRET-REF', receiptNumber: 'ABC123', rawPayload: { msisdn: '2547' } })]));
    expect(json).not.toMatch(/SECRET-REF|ABC123|msisdn|2547/);
  });
});

describe('service authorization and window', () => {
  const find = jest.fn();
  jest.unstable_mockModule('../../src/models/MpesaTransaction.js', () => ({ MpesaTransaction: { find: (...a) => find(...a), countDocuments: jest.fn() } }));
  jest.unstable_mockModule('../../src/utils/mpesaIndexReadiness.js', () => ({ inspectMpesaIndexes: async () => ({ gates: { canonicalQueryIndexes: true } }) }));
  let svc;
  beforeAll(async () => { ({ mpesaTransactionService: svc } = await import('../../src/services/mpesaTransaction.service.js')); });
  const cursorOf = (rows) => ({ select: () => ({ lean: () => ({ cursor: () => (async function* () { yield* rows; })() }) }) });
  const q = { startDate: '2026-06-01', endDate: '2026-06-30' };

  test('client-wide scope has no estate clause; restricted scope ANDs it, estateId can only narrow', async () => {
    find.mockReturnValue(cursorOf([]));
    await svc.summary('c1', null, q);
    expect(find.mock.calls[0][0].$and).toHaveLength(1);
    find.mockClear(); find.mockReturnValue(cursorOf([]));
    const res = await svc.summary('c1', ['eA'], { ...q, estateId: 'eB' });
    const and = find.mock.calls[0][0].$and;
    expect(and).toHaveLength(3);
    expect(JSON.stringify(and[1])).toContain('eA');
    expect(JSON.stringify(and[2])).toContain('eB');
    expect(res.scope).toBe('ESTATE_RESTRICTED');
  });
  test('always filters by clientId', async () => {
    find.mockClear(); find.mockReturnValue(cursorOf([]));
    await svc.summary('c9', null, q);
    expect(find.mock.calls[0][0].$and[0].clientId).toBe('c9');
  });
  test('rejects inverted, missing or oversized windows', async () => {
    await expect(svc.summary('c1', null, { startDate: '2026-06-30', endDate: '2026-06-01' })).rejects.toMatchObject({ status: 422 });
    await expect(svc.summary('c1', null, {})).rejects.toMatchObject({ status: 422 });
    await expect(svc.summary('c1', null, { startDate: '2026-01-01', endDate: '2026-12-31' })).rejects.toMatchObject({ status: 422 });
  });
});
