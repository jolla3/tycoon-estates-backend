import { schemas } from '../../src/utils/validators.js';

describe('tenant registration request validation', () => {
  const base = { name: 'Test Tenant', houseId: '64a000000000000000000001' };

  test('accepts registration without a phone number', () => {
    expect(schemas.createTenant.parse(base)).toMatchObject(base);
  });

  test('accepts blank or null phone as no phone on file', () => {
    expect(schemas.createTenant.parse({ ...base, phone: '' }).phone).toBe('');
    expect(schemas.createTenant.parse({ ...base, phone: '   ' }).phone).toBe('');
    expect(schemas.createTenant.parse({ ...base, phone: null }).phone).toBeNull();
  });

  test('still rejects malformed supplied phone numbers', () => {
    expect(() => schemas.createTenant.parse({ ...base, phone: '123' })).toThrow();
  });
});
