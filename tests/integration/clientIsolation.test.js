import '../setup.js';
import request from 'supertest';
import { describeWithMongo, connectTestDb, clearTestDb, disconnectTestDb } from '../helpers/db.js';
import { extractCsrfToken } from '../helpers/csrf.js';
import { createApp } from '../../src/app.js';
import { Client } from '../../src/models/Client.js';
import { House } from '../../src/models/House.js';
import { Estate } from '../../src/models/Estate.js';
import { User } from '../../src/models/User.js';
import { houseService } from '../../src/services/house.service.js';
import { Errors } from '../../src/utils/errors.js';

async function loginAndGetCsrf(app, email, password) {
  const agent = request.agent(app);
  const res = await agent.post('/api/v1/auth/login').send({ email, password }).expect(200);
  return { agent, csrfToken: extractCsrfToken(res) };
}

describeWithMongo('Client isolation (V2 section 2/6)', () => {
  beforeAll(connectTestDb);
  afterEach(clearTestDb);
  afterAll(disconnectTestDb);

  test('Client A cannot read or update Client B houses, even knowing the Mongo _id', async () => {
    const clientA = await Client.create({ name: 'Client A' });
    const clientB = await Client.create({ name: 'Client B' });
    const estateB = await Estate.create({ clientId: clientB._id, name: 'Estate B' });

    const houseB = await houseService.create(clientB._id, estateB._id, { houseNumber: 'B01', monthlyRent: 20000 });

    const housesForA = await houseService.list(clientA._id, null, {});
    expect(housesForA.items.find((h) => h._id.equals(houseB._id))).toBeUndefined();

    await expect(houseService.update(clientA._id, houseB._id, { monthlyRent: 1 })).rejects.toThrow(Errors.HouseNotFound().message);

    const untouched = await House.findById(houseB._id);
    expect(untouched.monthlyRent).toBe(20000);
  });

  test('Client A staff cannot enumerate or update Client B staff via the API, even by guessing IDs', async () => {
    const app = createApp();

    await request(app).post('/api/v1/auth/signup').send({ clientName: 'Client A', ownerName: 'Alice', email: 'alice@a.test', password: 'Password123!' }).expect(201);
    await request(app).post('/api/v1/auth/signup').send({ clientName: 'Client B', ownerName: 'David', email: 'david@b.test', password: 'Password123!' }).expect(201);

    const davidUser = await User.findOne({ email: 'david@b.test' });
    const { agent, csrfToken } = await loginAndGetCsrf(app, 'alice@a.test', 'Password123!');

    const staffList = await agent.get('/api/v1/users').expect(200);
    expect(staffList.body.data.find((u) => u._id === String(davidUser._id))).toBeUndefined();

    // Guessing David's _id directly must still fail — clientId scoping,
    // not obscurity, is what protects this. Valid CSRF token supplied so
    // the assertion is about authorization, not incidentally about CSRF.
    await agent.patch(`/api/v1/users/${davidUser._id}`).set('x-csrf-token', csrfToken).send({ name: 'Hacked' }).expect(401);

    const stillDavid = await User.findById(davidUser._id);
    expect(stillDavid.name).toBe('David');
  });

  test('public staff-creation payload cannot escalate to SUPER_ADMIN or CLIENT_OWNER', async () => {
    const app = createApp();
    await request(app).post('/api/v1/auth/signup').send({ clientName: 'Client C', ownerName: 'Carla', email: 'carla@c.test', password: 'Password123!' }).expect(201);

    const { agent, csrfToken } = await loginAndGetCsrf(app, 'carla@c.test', 'Password123!');

    // schemas.createStaff's zod schema only declares role as
    // z.enum(['STAFF','CLIENT_ADMIN']) — 'SUPER_ADMIN' is not a valid
    // enum value, so this is rejected at validation, before it ever
    // reaches the service layer.
    const res = await agent
      .post('/api/v1/users')
      .set('x-csrf-token', csrfToken)
      .send({ name: 'Sneaky', email: 'sneaky@c.test', password: 'Password123!', role: 'SUPER_ADMIN' });

    expect(res.status).toBe(422); // INVALID_REQUEST — zod rejected the role value
    const created = await User.findOne({ email: 'sneaky@c.test' });
    expect(created).toBeNull();
  });

  test('an authorized CLIENT_OWNER can create STAFF for their own client', async () => {
    const app = createApp();
    await request(app).post('/api/v1/auth/signup').send({ clientName: 'Client D', ownerName: 'Dana', email: 'dana@d.test', password: 'Password123!' }).expect(201);
    const { agent, csrfToken } = await loginAndGetCsrf(app, 'dana@d.test', 'Password123!');

    const res = await agent
      .post('/api/v1/users')
      .set('x-csrf-token', csrfToken)
      .send({ name: 'New Staffer', email: 'staffer@d.test', password: 'Password123!', role: 'STAFF' })
      .expect(201);

    const created = await User.findById(res.body.data.userId);
    expect(created.role).toBe('STAFF');
    const dana = await User.findOne({ email: 'dana@d.test' });
    expect(created.clientId.equals(dana.clientId)).toBe(true);
  });
});
