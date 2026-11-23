import {
  formatRegistrationPlanText,
  formatSmsDisplayLabel,
  prefixEstate,
} from '../../src/services/smsTemplates.js';

describe('registration SMS presentation', () => {
  test('capitalizes lowercase tenant, estate, and charge labels without rewriting intentional casing', () => {
    expect(formatSmsDisplayLabel('purity')).toBe('Purity');
    expect(formatSmsDisplayLabel('pendo estate')).toBe('Pendo Estate');
    expect(formatSmsDisplayLabel('litter')).toBe('Litter');
    expect(formatSmsDisplayLabel('eTIMS')).toBe('eTIMS');
  });

  test('renders every configured billing line separately without source enums or due days', () => {
    const message = formatRegistrationPlanText({
      outcome: 'RESOLVED',
      source: 'HOUSE_TYPE',
      lines: [
        { description: 'rent', chargeType: 'RENT', amountCents: 3002600, dueDay: 30 },
        { description: 'water', chargeType: 'WATER', amountCents: 100000, dueDay: 30 },
        { description: 'litter', chargeType: 'OTHER', amountCents: 50000, dueDay: 30 },
      ],
    });

    expect(message).toBe(
      'Your configured charges:\nRent: KES 30,026\nWater: KES 1,000\nLitter: KES 500.'
    );
    expect(message).not.toContain('HOUSE_TYPE');
    expect(message).not.toMatch(/due day/i);
    expect(message).not.toContain(';');
  });

  test('uses a display-cased estate prefix and does not duplicate an existing prefix', () => {
    expect(prefixEstate('pendo', 'Registration confirmed for Purity.')).toBe(
      'Pendo: Registration confirmed for Purity.'
    );
    expect(prefixEstate('pendo', 'pendo: Registration confirmed for Purity.')).toBe(
      'Pendo: Registration confirmed for Purity.'
    );
  });
});
