import { aggregateRentCharges, sumOutstandingCents } from '../../src/utils/smsBilling.js';

describe('G5 registration billing snapshot', () => {
  const rows = [
    { chargeType: 'RENT', amountDueCents: 800000, amountPaidCents: 200000, balanceCents: 600000, dueDate: new Date('2026-12-05T00:00:00.000Z') },
    { chargeType: 'RENT', amountDueCents: 50000, amountPaidCents: 0, balanceCents: 50000, dueDate: new Date('2026-12-05T00:00:00.000Z') },
    { chargeType: 'WATER', amountDueCents: 25000, amountPaidCents: 5000, balanceCents: 20000, dueDate: new Date('2026-12-05T00:00:00.000Z') },
    { chargeType: 'ELECTRICITY', amountDueCents: 10000, amountPaidCents: 10000, balanceCents: 0, dueDate: new Date('2026-12-05T00:00:00.000Z') },
  ];

  test('sums every RentCharge line using integer cents', () => {
    expect(aggregateRentCharges(rows)).toMatchObject({
      rentCents: 850000,
      waterCents: 25000,
      electricityCents: 10000,
      otherCents: 0,
      rentOutstandingCents: 650000,
      waterOutstandingCents: 20000,
      electricityOutstandingCents: 0,
      otherOutstandingCents: 0,
      paidCents: 215000,
      totalOutstandingCents: 670000,
      lineCount: 4,
    });
  });

  test('does not invent a zero bill when no charge rows exist', () => {
    expect(() => aggregateRentCharges([])).toThrow(/not available/i);
  });

  test('rejects absent or unsafe cent values and invalid due dates', () => {
    expect(() => aggregateRentCharges([{ chargeType: 'RENT', amountDueCents: undefined, amountPaidCents: 0, balanceCents: 0 }])).toThrow(/amountDueCents/);
    expect(() => aggregateRentCharges([{ chargeType: 'RENT', amountDueCents: Number.MAX_SAFE_INTEGER + 1, amountPaidCents: 0, balanceCents: 0 }])).toThrow(/amountDueCents/);
    expect(() => aggregateRentCharges([{ chargeType: 'RENT', amountDueCents: 1, amountPaidCents: 0, balanceCents: 1, dueDate: 'bad-date' }])).toThrow(/due date/i);
  });

  test('counts only positive arrears and safely supports no historic charges', () => {
    expect(sumOutstandingCents([{ chargeType: 'RENT', amountDueCents: 100, amountPaidCents: 120, balanceCents: -20 }])).toBe(0);
    expect(sumOutstandingCents([])).toBe(0);
  });
});
