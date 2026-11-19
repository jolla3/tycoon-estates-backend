import { houseTypeCreateSchema, houseTypeUpdateSchema } from '../../src/routes/houseType.routes.js';

const ESTATE = '64b7f0a1c2d3e4f5a6b7c8d9';

describe('houseType route schemas', () => {
  test('create retains a valid estateId', () => {
    const r = houseTypeCreateSchema.safeParse({ estateId: ESTATE, name: '1BR' });
    expect(r.success).toBe(true);
    expect(r.data.estateId).toBe(ESTATE);
  });
  test('create rejects a missing estateId', () => {
    expect(houseTypeCreateSchema.safeParse({ name: '1BR' }).success).toBe(false);
  });
  test('create rejects a malformed estateId', () => {
    expect(houseTypeCreateSchema.safeParse({ estateId: 'not-an-id', name: '1BR' }).success).toBe(false);
  });
  test('update forwards estateId so the service can reject an ownership move', () => {
    const r = houseTypeUpdateSchema.safeParse({ estateId: ESTATE, name: 'Renamed' });
    expect(r.success).toBe(true);
    expect(r.data.estateId).toBe(ESTATE);
  });
  test('update rejects a malformed estateId', () => {
    expect(houseTypeUpdateSchema.safeParse({ estateId: 'nope' }).success).toBe(false);
  });
  test('update still accepts partial fields', () => {
    expect(houseTypeUpdateSchema.safeParse({ defaultRentCents: 1000 }).success).toBe(true);
  });
});
