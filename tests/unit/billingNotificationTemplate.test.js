import { previewSms } from '../../src/services/sms.service.js';

describe('G5 billing statement template', () => {
  const variables = {
    tenantName: 'Sample Tenant',
    houseNumber: 'A-01, A-02',
    period: '2026-12',
    rentOutstandingCents: 650000,
    waterOutstandingCents: 20000,
    electricityOutstandingCents: 0,
    otherOutstandingCents: 10000,
    previousArrearsCents: 50000,
    paidCents: 217000,
    totalOutstandingCents: 730000,
    dueDate: '05 Dec 2026',
    currency: 'KES',
  };

  test('renders outstanding items and previous arrears separately', () => {
    const message = previewSms('billing_notification', variables);
    expect(message).toContain('Rent outstanding:');
    expect(message).toContain('Water outstanding:');
    expect(message).toContain('Other outstanding:');
    expect(message).toContain('Previous arrears:');
    expect(message).toContain('Total outstanding:');
    expect(message).not.toContain('Electricity outstanding:');
  });

  test('does not substitute missing or unsafe cent values with zero', () => {
    const { waterOutstandingCents, ...missing } = variables;
    expect(() => previewSms('billing_notification', missing)).toThrow(/waterOutstandingCents/);
    expect(() => previewSms('billing_notification', {
      ...variables,
      rentOutstandingCents: Number.MAX_SAFE_INTEGER + 1,
    })).toThrow(/rentOutstandingCents/);
  });
});
