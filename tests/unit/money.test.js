import '../setup.js';
import { money } from '../../src/utils/money.js';

describe('utils/money (integer-cents arithmetic)', () => {
  test('toCents/fromCents round-trip without floating-point drift', () => {
    expect(money.toCents(15000)).toBe(1500000);
    expect(money.fromCents(1500000)).toBe(15000);
    expect(money.toCents(19.99)).toBe(1999);
  });

  test('add/subtract operate purely in integer cents', () => {
    expect(money.add(1000, 250)).toBe(1250);
    expect(money.subtract(1000, 1500)).toBe(-500);
  });

  test('isPositive', () => {
    expect(money.isPositive(1)).toBe(true);
    expect(money.isPositive(0)).toBe(false);
    expect(money.isPositive(-1)).toBe(false);
  });

  test('format renders a currency string', () => {
    expect(money.format(1500000, 'KES')).toContain('KES');
  });
});
