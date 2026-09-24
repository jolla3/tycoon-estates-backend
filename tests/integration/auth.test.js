import '../setup.js';
import request from 'supertest';
import { describeWithMongo, connectTestDb, clearTestDb, disconnectTestDb } from '../helpers/db.js';
import { extractCsrfToken } from '../helpers/csrf.js';
import { createApp } from '../../src/app.js';

describeWithMongo('Authentication', () => {
  let app;

  beforeAll(async () => {
    await connectTestDb();
    app = createApp();
  });
  afterEach(async () => clearTestDb());
  afterAll(async () => disconnectTestDb());

  test('signup creates a Client + CLIENT_OWNER, then login succeeds and sets a session cookie', async () => {
    const email = 'owner@example.com';
    await request(app).post('/api/v1/auth/signup').send({ clientName: 'Acme Estates', ownerName: 'Ada', email, password: 'Password123!' }).expect(201);

    const res = await request(app).post('/api/v1/auth/login').send({ email, password: 'Password123!' }).expect(200);
    expect(res.body.data.role).toBe('CLIENT_OWNER');
    expect(res.headers['set-cookie'].some((c) => c.startsWith('connect.sid'))).toBe(true);
  });

  test('signup cannot be used to create a SUPER_ADMIN or attach to an existing client — the payload has no such fields', async () => {
    const res = await request(app)
      .post('/api/v1/auth/signup')
      .send({ clientName: 'X', ownerName: 'Y', email: 'z@example.com', password: 'Password123!', role: 'SUPER_ADMIN', clientId: '000000000000000000000000' })
      .expect(201);
    // Smuggled fields are simply not part of the signup schema — the
    // created user is always CLIENT_OWNER of a brand-new client.
    const login = await request(app).post('/api/v1/auth/login').send({ email: 'z@example.com', password: 'Password123!' }).expect(200);
    expect(login.body.data.role).toBe('CLIENT_OWNER');
  });

  test('login with wrong password fails', async () => {
    const email = 'wrongpass@example.com';
    await request(app).post('/api/v1/auth/signup').send({ clientName: 'X', ownerName: 'Y', email, password: 'Password123!' }).expect(201);
    await request(app).post('/api/v1/auth/login').send({ email, password: 'WrongPassword' }).expect(401);
  });

  test('protected route rejects an unauthenticated request', async () => {
    await request(app).get('/api/v1/auth/me').expect(401);
  });

  test('logout clears the session', async () => {
    const email = 'logout-test@example.com';
    await request(app).post('/api/v1/auth/signup').send({ clientName: 'X', ownerName: 'Y', email, password: 'Password123!' }).expect(201);
    const agent = request.agent(app);
    const loginRes = await agent.post('/api/v1/auth/login').send({ email, password: 'Password123!' }).expect(200);
    await agent.get('/api/v1/auth/me').expect(200);

    // Logout is a state-changing (POST) request, so — unlike login/signup
    // — it genuinely needs a valid CSRF token, echoed back exactly as a
    // real browser frontend would.
    const csrfToken = extractCsrfToken(loginRes);
    await agent.post('/api/v1/auth/logout').set('x-csrf-token', csrfToken).expect(200);
    await agent.get('/api/v1/auth/me').expect(401);
  });

  test('logout without a valid CSRF token is rejected', async () => {
    const email = 'logout-nocsrf@example.com';
    await request(app).post('/api/v1/auth/signup').send({ clientName: 'X', ownerName: 'Y', email, password: 'Password123!' }).expect(201);
    const agent = request.agent(app);
    await agent.post('/api/v1/auth/login').send({ email, password: 'Password123!' }).expect(200);
    await agent.post('/api/v1/auth/logout').expect(403); // no X-CSRF-Token header supplied
  });
});
