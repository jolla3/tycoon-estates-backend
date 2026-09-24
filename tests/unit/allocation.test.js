import { planAllocation, sortChargesForAllocation, statusAfterPayment, CHARGE_TYPE_PRIORITY } from '../../src/utils/allocation.js';

describe('allocation', () => {
  test('sorts older periods first, then RENT before WATER', () => {
    const sorted = sortChargesForAllocation([
      { period: '2026-09', chargeType: 'WATER', balanceCents: 1000 },
      { period: '2026-08', chargeType: 'RENT', balanceCents: 5000 },
      { period: '2026-08', chargeType: 'WATER', balanceCents: 1000 },
      { period: '2026-09', chargeType: 'RENT', balanceCents: 10000 },
    ]);
    expect(sorted.map((c) => `${c.period}:${c.chargeType}`)).toEqual([
      '2026-08:RENT',
      '2026-08:WATER',
      '2026-09:RENT',
      '2026-09:WATER',
    ]);
  });

  test('allocates oldest outstanding first (partial payment)', () => {
    const charges = [
      { _id: '1', period: '2026-08', chargeType: 'RENT', balanceCents: 5000, amountDueCents: 10000, amountPaidCents: 5000 },
      { _id: '2', period: '2026-08', chargeType: 'WATER', balanceCents: 1000, amountDueCents: 1000, amountPaidCents: 0 },
      { _id: '3', period: '2026-08', chargeType: 'ELECTRICITY', balanceCents: 2000, amountDueCents: 2000, amountPaidCents: 0 },
      { _id: '4', period: '2026-09', chargeType: 'RENT', balanceCents: 10000, amountDueCents: 10000, amountPaidCents: 0 },
    ];
    const plan = planAllocation(charges, 7000);
    expect(plan.map((p) => ({ type: p.charge.chargeType, period: p.charge.period, amount: p.amountCents }))).toEqual([
      { type: 'RENT', period: '2026-08', amount: 5000 },
      { type: 'WATER', period: '2026-08', amount: 1000 },
      { type: 'ELECTRICITY', period: '2026-08', amount: 1000 },
    ]);
  });

  test('statusAfterPayment', () => {
    expect(statusAfterPayment(10000, 10000)).toBe('PAID');
    expect(statusAfterPayment(10000, 5000)).toBe('PARTIAL');
    expect(statusAfterPayment(10000, 0)).toBe('UNPAID');
    expect(statusAfterPayment(10000, 12000)).toBe('OVERPAID');
  });

  test('CHARGE_TYPE_PRIORITY ordering', () => {
    expect(CHARGE_TYPE_PRIORITY.RENT).toBeLessThan(CHARGE_TYPE_PRIORITY.WATER);
    expect(CHARGE_TYPE_PRIORITY.WATER).toBeLessThan(CHARGE_TYPE_PRIORITY.ELECTRICITY);
  });
});
