import '../setup.js';
import { describeWithMongo, connectTestDb, clearTestDb, disconnectTestDb } from '../helpers/db.js';
import { Client } from '../../src/models/Client.js';
import { Estate } from '../../src/models/Estate.js';
import { houseService } from '../../src/services/house.service.js';

describeWithMongo('Houses', () => {
  let client, estate;
  beforeAll(async () => { await connectTestDb(); });
  beforeEach(async () => {
    client = await Client.create({ name: 'Test Client' });
    estate = await Estate.create({ clientId: client._id, name: 'Test Estate' });
  });
  afterEach(clearTestDb);
  afterAll(disconnectTestDb);

  test('creates a house', async () => {
    const house = await houseService.create(client._id, estate._id, { houseNumber: 'A01', monthlyRent: 15000 });
    expect(house.houseNumber).toBe('A01');
    expect(house.clientId.equals(client._id)).toBe(true);
  });

  test('updates a house', async () => {
    const house = await houseService.create(client._id, estate._id, { houseNumber: 'A01', monthlyRent: 15000 });
    const updated = await houseService.update(client._id, house._id, { monthlyRent: 16000 });
    expect(updated.monthlyRent).toBe(16000);
  });

  test('rejects a duplicate house number within the same estate', async () => {
    await houseService.create(client._id, estate._id, { houseNumber: 'A01', monthlyRent: 15000 });
    await expect(houseService.create(client._id, estate._id, { houseNumber: 'A01', monthlyRent: 18000 })).rejects.toThrow();
  });

  test('allows the same house number across different estates (even under the same client)', async () => {
    const otherEstate = await Estate.create({ clientId: client._id, name: 'Other Estate' });
    await houseService.create(client._id, estate._id, { houseNumber: 'A01', monthlyRent: 15000 });
    await expect(houseService.create(client._id, otherEstate._id, { houseNumber: 'A01', monthlyRent: 15000 })).resolves.toBeTruthy();
  });

  test('cannot create a house under an estate belonging to a different client', async () => {
    const otherClient = await Client.create({ name: 'Other Client' });
    await expect(houseService.create(otherClient._id, estate._id, { houseNumber: 'X01', monthlyRent: 1000 })).rejects.toThrow();
  });
});
