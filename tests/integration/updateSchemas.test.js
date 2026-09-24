import '../setup.js';
import { describeWithMongo, connectTestDb, clearTestDb, disconnectTestDb } from '../helpers/db.js';
import { Client } from '../../src/models/Client.js';
import { Estate } from '../../src/models/Estate.js';
import { House } from '../../src/models/House.js';
import { Tenant } from '../../src/models/Tenant.js';
import { schemas } from '../../src/utils/validators.js';
import { houseService } from '../../src/services/house.service.js';
import { tenantService } from '../../src/services/tenant.service.js';

describeWithMongo('Update schemas cannot be used to corrupt relationships', () => {
  let client, estateA, estateB, houseA, houseB, tenant;

  beforeAll(connectTestDb);
  beforeEach(async () => {
    client = await Client.create({ name: 'Client' });
    estateA = await Estate.create({ clientId: client._id, name: 'Estate A' });
    estateB = await Estate.create({ clientId: client._id, name: 'Estate B' });
    houseA = await House.create({ clientId: client._id, estateId: estateA._id, houseNumber: 'A01', monthlyRent: 10000, status: 'occupied' });
    houseB = await House.create({ clientId: client._id, estateId: estateB._id, houseNumber: 'B01', monthlyRent: 20000 });
    tenant = await Tenant.create({ clientId: client._id, estateId: estateA._id, houseId: houseA._id, name: 'Tenant One', phone: '+254700000001' });
    houseA.tenantId = tenant._id;
    await houseA.save();
  });
  afterEach(clearTestDb);
  afterAll(disconnectTestDb);

  test('schemas.updateHouse strips estateId/tenantId/clientId even if supplied', () => {
    const parsed = schemas.updateHouse.parse({ houseNumber: 'A01-renamed', estateId: String(estateB._id), tenantId: 'x', clientId: 'y' });
    expect(parsed).toEqual({ houseNumber: 'A01-renamed' });
  });

  test('houseService.update only ever applies the whitelisted fields it is given', async () => {
    const updated = await houseService.update(client._id, houseA._id, { monthlyRent: 12000 });
    expect(updated.monthlyRent).toBe(12000);
    expect(updated.estateId.equals(estateA._id)).toBe(true); // unchanged
  });

  test('schemas.updateTenant strips houseId even if supplied', () => {
    const parsed = schemas.updateTenant.parse({ name: 'Renamed', houseId: 'x' });
    expect(parsed).toEqual({ name: 'Renamed' });
  });

  test('tenantService.moveToHouse vacates the old house atomically when moving a tenant', async () => {
    const moved = await tenantService.moveToHouse(client._id, tenant._id, houseB._id);
    expect(moved.houseId.equals(houseB._id)).toBe(true);
    expect(moved.estateId.equals(estateB._id)).toBe(true);

    const oldHouse = await House.findById(houseA._id);
    expect(oldHouse.tenantId).toBeNull();
    expect(oldHouse.status).toBe('vacant');

    const newHouse = await House.findById(houseB._id);
    expect(newHouse.tenantId.equals(tenant._id)).toBe(true);
    expect(newHouse.status).toBe('occupied');
  });

  test('tenantService.moveToHouse refuses to move into a house belonging to a different client', async () => {
    const otherClient = await Client.create({ name: 'Other Client' });
    const otherEstate = await Estate.create({ clientId: otherClient._id, name: 'Other Estate' });
    const otherHouse = await House.create({ clientId: otherClient._id, estateId: otherEstate._id, houseNumber: 'X01', monthlyRent: 5000 });

    await expect(tenantService.moveToHouse(client._id, tenant._id, otherHouse._id)).rejects.toThrow();
  });

  test('schemas.updateStaff strips passwordHash/role/clientId/isActive even if supplied', () => {
    const parsed = schemas.updateStaff.parse({ name: 'New Name', passwordHash: 'x', role: 'SUPER_ADMIN', clientId: 'y', isActive: false });
    expect(parsed).toEqual({ name: 'New Name' });
  });
});
