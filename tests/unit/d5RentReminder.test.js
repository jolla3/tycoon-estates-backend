import { previewSms } from '../../src/services/sms.service.js';
import { dateUtil } from '../../src/utils/date.js';

describe('G5 D-5 rent reminder', () => {
  const variables = {
    tenantName: 'Sample Tenant',
    houseNumber: 'A-01',
    period: '2026-12',
    dueDate: '05 Dec 2026',
    rentOutstandingCents: 650000,
    waterOutstandingCents: 20000,
    electricityOutstandingCents: 0,
    otherOutstandingCents: 10000,
    previousArrearsCents: 50000,
    totalOutstandingCents: 730000,
    currency: 'KES',
  };

  test('includes outstanding amounts by type, arrears and the saved due date', () => {
    const message = previewSms('rent_reminder_d5', variables);
    expect(message).toContain('Rent due in five days on 05 Dec 2026');
    expect(message).toContain('Rent outstanding:');
    expect(message).toContain('Water outstanding:');
    expect(message).toContain('Other outstanding:');
    expect(message).toContain('Previous arrears:');
    expect(message).toContain('Total outstanding:');
    expect(message).not.toContain('Electricity outstanding:');
  });

  test('rejects incomplete financial or due-date data instead of printing zero/undefined', () => {
    const { rentOutstandingCents, ...missingAmount } = variables;
    expect(() => previewSms('rent_reminder_d5', missingAmount)).toThrow(/rentOutstandingCents/);
    expect(() => previewSms('rent_reminder_d5', { ...variables, dueDate: '' })).toThrow(/dueDate/);
    expect(() => previewSms('rent_reminder_d5', { ...variables, totalOutstandingCents: NaN })).toThrow(/totalOutstandingCents/);
  });

  test('uses Nairobi calendar-day boundaries for saved due dates', () => {
    const range = dateUtil.parseNairobiDateOnly('2026-12-05');
    expect(range).not.toBeNull();
    expect(dateUtil.format(range.start, 'YYYY-MM-DD HH:mm')).toBe('2026-12-05 00:00');
    expect(dateUtil.format(range.end, 'YYYY-MM-DD HH:mm')).toBe('2026-12-05 23:59');
    expect(dateUtil.parseNairobiDateOnly('2026-02-31')).toBeNull();
  });
});
