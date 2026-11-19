import { createMpesaProfileSchema } from '../../src/routes/platform.routes.js';

describe('Superadmin M-PESA profile creation schema', () => {
  const estateId = '64b7f0a1c2d3e4f5a6b7c8d9';

  test('accepts a numeric Till shortcode and one estate mapping', () => {
    const parsed = createMpesaProfileSchema.safeParse({
      businessShortCode: '123456',
      estateId,
      displayName: 'Main estate Till',
    });
    expect(parsed.success).toBe(true);
    expect(parsed.data.businessShortCode).toBe('123456');
  });

  test('rejects non-numeric shortcode and malformed estate id', () => {
    expect(createMpesaProfileSchema.safeParse({ businessShortCode: 'ABC123', estateId }).success).toBe(false);
    expect(createMpesaProfileSchema.safeParse({ businessShortCode: '123456', estateId: 'bad' }).success).toBe(false);
  });

  test('does not accept caller-supplied operational or credential fields', () => {
    expect(createMpesaProfileSchema.safeParse({
      businessShortCode: '123456',
      estateId,
      operationalState: 'ACTIVE',
      consumerKey: 'secret',
      consumerSecret: 'secret',
    }).success).toBe(false);
  });
});
