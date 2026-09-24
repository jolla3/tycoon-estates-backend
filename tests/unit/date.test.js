import '../setup.js';
import { dateUtil, BUSINESS_TZ } from '../../src/utils/date.js';

describe('utils/date (Africa/Nairobi business time)', () => {
  test('BUSINESS_TZ is Africa/Nairobi', () => {
    expect(BUSINESS_TZ).toBe('Africa/Nairobi');
  });

  test('currentPeriod returns YYYY-MM', () => {
    expect(dateUtil.currentPeriod()).toMatch(/^\d{4}-\d{2}$/);
  });

  test('periodOf extracts the Nairobi-local period from a UTC instant near midnight', () => {
    // 2026-01-31T22:30:00Z is 2026-02-01T01:30 EAT (+03:00) — must roll into February.
    const period = dateUtil.periodOf('2026-01-31T22:30:00Z');
    expect(period).toBe('2026-02');
  });

  test('dueDateFor adds (dueDay - 1) days onto the start of the period', () => {
    const due = dateUtil.dueDateFor('2026-03', 5);
    expect(due.getUTCFullYear()).toBe(2026);
    // Day 5 of March, Nairobi-local start-of-day.
    expect(dateUtil.format(due, 'YYYY-MM-DD')).toBe('2026-03-05');
  });

  test('startOfMonth / endOfMonth bracket the whole period', () => {
    const start = dateUtil.startOfMonth('2026-06');
    const end = dateUtil.endOfMonth('2026-06');
    expect(start.isBefore(end)).toBe(true);
    expect(dateUtil.format(start.toDate(), 'YYYY-MM-DD')).toBe('2026-06-01');
    expect(dateUtil.format(end.toDate(), 'YYYY-MM-DD')).toBe('2026-06-30');
  });
});
