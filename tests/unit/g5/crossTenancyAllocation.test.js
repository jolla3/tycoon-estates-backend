import { planTenantAllocation, planReceiptWithCredit, sortObligations } from '../../../src/utils/crossTenancyAllocation.js';

const ch = (id, tenancyId, period, balanceCents, extra = {}) => ({ _id: id, tenancyId, period, balanceCents, chargeType: 'RENT', dueDate: new Date(`${period}-05T00:00:00Z`), ...extra });
const starts = new Map([['T1', new Date('2025-01-01')], ['T2', new Date('2026-01-01')]]);

describe('cross-Tenancy allocation', () => {
  test('oldest period first across Tenancies including closed arrears', () => {
    const charges = [ch('c3', 'T2', '2026-03', 100), ch('c1', 'T1', '2026-01', 100), ch('c2', 'T2', '2026-02', 100)];
    const p = planTenantAllocation(charges, 250, { tenancyStartMs: starts });
    expect(p.slices.map((s) => [s.charge._id, s.amountCents])).toEqual([['c1', 100], ['c2', 100], ['c3', 50]]);
    expect(p.surplusCents).toBe(0);
  });
  test('stable tie-breakers: dueDate, type, tenancy start, ids', () => {
    const same = [
      ch('b', 'T2', '2026-01', 10, { chargeType: 'WATER' }), ch('a', 'T2', '2026-01', 10),
      ch('z', 'T1', '2026-01', 10), ch('y', 'T2', '2026-01', 10, { dueDate: new Date('2026-01-01T00:00:00Z') }),
    ];
    const order = sortObligations(same, starts).map((c) => c._id);
    expect(order).toEqual(['y', 'z', 'a', 'b']);
    expect(sortObligations([...same].reverse(), starts).map((c) => c._id)).toEqual(order);
  });
  test('never over-allocates; surplus returned as credit', () => {
    const p = planTenantAllocation([ch('c1', 'T1', '2026-01', 100)], 350, { tenancyStartMs: starts });
    expect(p.allocatedCents).toBe(100);
    expect(p.surplusCents).toBe(250);
  });
  test('no obligations => whole receipt becomes credit', () => {
    const p = planReceiptWithCredit([], { receiptCents: 5000, creditCents: 0 });
    expect(p.newCreditCents).toBe(5000);
    expect(p.receiptSlices).toHaveLength(0);
  });
  test('existing credit pays oldest first, then receipt pays next', () => {
    const charges = [ch('c1', 'T1', '2026-01', 100), ch('c2', 'T1', '2026-02', 100)];
    const p = planReceiptWithCredit(charges, { receiptCents: 80, creditCents: 130 }, { tenancyStartMs: starts });
    expect(p.creditSlices.map((s) => [s.charge._id, s.amountCents])).toEqual([['c1', 100], ['c2', 30]]);
    expect(p.receiptSlices.map((s) => [s.charge._id, s.amountCents])).toEqual([['c2', 70]]);
    expect(p.newCreditCents).toBe(10);
  });
  test('conservation holds on random inputs; inputs not mutated', () => {
    let seed = 7;
    const rnd = (n) => { seed = (seed * 1103515245 + 12345) % 2147483648; return seed % n; };
    for (let i = 0; i < 300; i += 1) {
      const charges = Array.from({ length: rnd(8) }, (_, k) => ch(`c${k}`, rnd(2) ? 'T1' : 'T2', `2026-0${1 + rnd(9)}`, 1 + rnd(5000)));
      const snapshot = JSON.stringify(charges);
      const receipt = rnd(20000); const credit = rnd(8000);
      const p = planReceiptWithCredit(charges, { receiptCents: receipt, creditCents: credit }, { tenancyStartMs: starts });
      expect(p.receiptAppliedCents + p.newCreditCents).toBe(receipt);
      expect(p.creditAppliedCents + p.creditRemainingCents).toBe(credit);
      const per = new Map();
      for (const s of [...p.creditSlices, ...p.receiptSlices]) per.set(s.charge._id, (per.get(s.charge._id) || 0) + s.amountCents);
      for (const c of charges) expect(per.get(c._id) || 0).toBeLessThanOrEqual(c.balanceCents);
      expect(JSON.stringify(charges)).toBe(snapshot);
    }
  });
  test('rejects non-integer / negative pools', () => {
    expect(() => planTenantAllocation([], 1.5)).toThrow();
    expect(() => planTenantAllocation([], -1)).toThrow();
    expect(() => planReceiptWithCredit([], { receiptCents: 10, creditCents: 0.1 })).toThrow();
  });
});
