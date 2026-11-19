/**
 * HouseType estate ownership (DB-backed). Same environment requirements as g3.accounting.test.js;
 * skipped without a disposable replica-set MONGODB_URI. NOTE: authored without MongoDB; not yet executed.
 */
import '../setup.js';
import { describeWithMongo, connectTestDb, clearTestDb, disconnectTestDb } from '../helpers/db.js';
import { prepareG3TestIndexes } from '../helpers/g3Indexes.js';
import { Client } from '../../src/models/Client.js';
import { Estate } from '../../src/models/Estate.js';
import { HouseType } from '../../src/models/HouseType.js';
import { houseTypeService } from '../../src/services/houseType.service.js';

describeWithMongo('HouseType estate ownership', () => {
  let client, other, estate, estate2, foreignEstate;
  beforeAll(connectTestDb);
  afterAll(disconnectTestDb);
  beforeEach(async () => {
    await clearTestDb();
    await prepareG3TestIndexes();
    client = await Client.create({ name: 'C1' });
    other = await Client.create({ name: 'C2' });
    estate = await Estate.create({ clientId: client._id, name: 'E1', isActive: true });
    estate2 = await Estate.create({ clientId: client._id, name: 'E2', isActive: true });
    foreignEstate = await Estate.create({ clientId: other._id, name: 'F1', isActive: true });
  });

  test('valid estateId is persisted', async () => {
    const created = await houseTypeService.create(client._id, { estateId: String(estate._id), name: 'Studio', defaultRentCents: 100000 });
    const stored = await HouseType.findById(created._id).lean();
    expect(String(stored.estateId)).toBe(String(estate._id));
    expect(String(stored.clientId)).toBe(String(client._id));
  });
  test('missing estateId is rejected by the service as well', async () => {
    await expect(houseTypeService.create(client._id, { name: 'Studio' })).rejects.toMatchObject({ code: 'INVALID_REQUEST' });
  });
  test("another client's estate is rejected and nothing is created", async () => {
    await expect(houseTypeService.create(client._id, { estateId: String(foreignEstate._id), name: 'Studio' })).rejects.toMatchObject({ code: 'ESTATE_NOT_FOUND' });
    expect(await HouseType.countDocuments({})).toBe(0);
  });
  test('estate ownership cannot be changed by update', async () => {
    const created = await houseTypeService.create(client._id, { estateId: String(estate._id), name: 'Studio' });
    await expect(houseTypeService.update(client._id, created._id, { estateId: String(estate2._id) })).rejects.toMatchObject({ code: 'INVALID_REQUEST' });
    expect(String((await HouseType.findById(created._id).lean()).estateId)).toBe(String(estate._id));
  });
});
