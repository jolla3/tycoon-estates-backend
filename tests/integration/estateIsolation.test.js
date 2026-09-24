import '../setup.js';
import request from 'supertest';
import { describeWithMongo, connectTestDb, clearTestDb, disconnectTestDb } from '../helpers/db.js';
import { extractCsrfToken } from '../helpers/csrf.js';
import { createApp } from '../../src/app.js';
import { Client } from '../../src/models/Client.js';
import { Estate } from '../../src/models/Estate.js';
import { House } from '../../src/models/House.js';
import { User } from '../../src/models/User.js';
import { authService } from '../../src/services/auth.service.js';
import { houseService } from '../../src/services/house.service.js';
import { tenantService } from '../../src/services/tenant.service.js';
import { transactionService } from '../../src/services/transaction.service.js';
import { bankService } from '../../src/services/bank.service.js';
import { Tenant } from '../../src/models/Tenant.js';
import { BankTransaction } from '../../src/models/BankTransaction.js';
import { BankAccount } from '../../src/models/BankAccount.js';
import { Errors } from '../../src/utils/errors.js';

async function loginAndGetCsrf(app, email, password) {
  const agent = request.agent(app);
  const res = await agent.post('/api/v1/auth/login').send({ email, password }).expect(200);
  return { agent, csrfToken: extractCsrfToken(res) };
}

describeWithMongo('Estate-level staff isolation (the specific bug this hardening pass fixes)', () => {
  let app, client, estateA, estateB, houseA, houseB;

  beforeAll(async () => {
    await connectTestDb();
    app = createApp();
  });
  beforeEach(async () => {
    const { client: c } = await authService.signup({ clientName: 'Multi-Estate Co', ownerName: 'Owner', email: 'owner@multi.test', password: 'Password123!' });
    client = c;
    estateA = await Estate.create({ clientId: client._id, name: 'Estate A' });
    estateB = await Estate.create({ clientId: client._id, name: 'Estate B' });
    houseA = await House.create({ clientId: client._id, estateId: estateA._id, houseNumber: 'A01', monthlyRent: 10000 });
    houseB = await House.create({ clientId: client._id, estateId: estateB._id, houseNumber: 'B01', monthlyRent: 20000 });

    await authService.createStaff(client._id, {
      name: 'Estate A Staff', email: 'staffA@multi.test', password: 'Password123!', role: 'STAFF', estateIds: [estateA._id],
    });
  });
  afterEach(clearTestDb);
  afterAll(disconnectTestDb);

  test('a staff member restricted to Estate A sees ONLY Estate A houses, even with no estateId in the request', async () => {
    const { agent } = await loginAndGetCsrf(app, 'staffA@multi.test', 'Password123!');

    const res = await agent.get('/api/v1/houses').expect(200);
    const houseIds = res.body.data.items.map((h) => h._id);

    expect(houseIds).toContain(String(houseA._id));
    expect(houseIds).not.toContain(String(houseB._id)); // THE bug this test guards against
  });

  test('the same restricted staff member is rejected with 403 if they explicitly request Estate B', async () => {
    const { agent } = await loginAndGetCsrf(app, 'staffA@multi.test', 'Password123!');
    await agent.get(`/api/v1/houses?estateId=${estateB._id}`).expect(403);
  });

  test('an unrestricted CLIENT_OWNER (empty estateIds) sees houses across both estates', async () => {
    const { agent } = await loginAndGetCsrf(app, 'owner@multi.test', 'Password123!');
    const res = await agent.get('/api/v1/houses').expect(200);
    const houseIds = res.body.data.items.map((h) => h._id);
    expect(houseIds).toEqual(expect.arrayContaining([String(houseA._id), String(houseB._id)]));
  });

  test('createStaff rejects an estateId belonging to a different client', async () => {
    const otherClient = await Client.create({ name: 'Other Client' });
    const otherEstate = await Estate.create({ clientId: otherClient._id, name: 'Other Estate' });

    await expect(
      authService.createStaff(client._id, { name: 'Sneaky', email: 'sneaky@multi.test', password: 'Password123!', role: 'STAFF', estateIds: [otherEstate._id] })
    ).rejects.toThrow(/do not belong to your client/);

    const created = await User.findOne({ email: 'sneaky@multi.test' });
    expect(created).toBeNull();
  });

  test('updateStaff also rejects an estateId belonging to a different client', async () => {
    const staff = await User.findOne({ email: 'staffA@multi.test' });
    const otherClient = await Client.create({ name: 'Other Client 2' });
    const otherEstate = await Estate.create({ clientId: otherClient._id, name: 'Other Estate 2' });

    await expect(authService.updateStaff(client._id, staff._id, { estateIds: [otherEstate._id] })).rejects.toThrow(/do not belong to your client/);
  });

  test('restricted STAFF cannot preview SMS for a tenant in Estate B by guessing tenantId', async () => {
    const { Tenant } = await import('../../src/models/Tenant.js');
    const tenantB = await Tenant.create({
      clientId: client._id,
      estateId: estateB._id,
      houseId: houseB._id,
      name: 'Tenant B',
      phone: '+254700000099',
      status: 'active',
    });

    const { agent, csrfToken } = await loginAndGetCsrf(app, 'staffA@multi.test', 'Password123!');
    const res = await agent
      .post('/api/v1/sms/preview')
      .set('x-csrf-token', csrfToken)
      .send({ tenantId: String(tenantB._id), template: 'billing_notification' });

    // Must not leak Estate B tenant data — 404 TenantNotFound (scoped miss)
    expect([404, 403]).toContain(res.status);
    if (res.body?.data?.variables?.tenantName) {
      expect(res.body.data.variables.tenantName).not.toBe('Tenant B');
    }
  });


  // ── Service-layer estate isolation (defense in depth, independent of route authorize) ──

  test('houseService.update rejects Estate B house when estateFilter is Estate A only', async () => {
    await expect(
      houseService.update(client._id, houseB._id, { monthlyRent: 1 }, [String(estateA._id)])
    ).rejects.toThrow(Errors.HouseNotFound().message);

    const untouched = await House.findById(houseB._id);
    expect(untouched.monthlyRent).toBe(20000);
  });

  test('houseService.update succeeds for Estate A house under Estate A filter and for OWNER with null filter', async () => {
    const updatedA = await houseService.update(client._id, houseA._id, { monthlyRent: 11000 }, [String(estateA._id)]);
    expect(updatedA.monthlyRent).toBe(11000);

    const updatedB = await houseService.update(client._id, houseB._id, { monthlyRent: 21000 }, null);
    expect(updatedB.monthlyRent).toBe(21000);
  });

  test('tenantService.update rejects Estate B tenant when estateFilter is Estate A only', async () => {
    const tenantB = await Tenant.create({
      clientId: client._id, estateId: estateB._id, houseId: houseB._id,
      name: 'Tenant B Upd', phone: '+254700000011', status: 'active',
    });
    await expect(
      tenantService.update(client._id, tenantB._id, { name: 'Hacked' }, [String(estateA._id)])
    ).rejects.toThrow(Errors.TenantNotFound().message);

    const untouched = await Tenant.findById(tenantB._id);
    expect(untouched.name).toBe('Tenant B Upd');
  });

  test('tenantService.moveToHouse rejects move into Estate B when filter is Estate A only', async () => {
    const tenantA = await Tenant.create({
      clientId: client._id, estateId: estateA._id, houseId: houseA._id,
      name: 'Tenant A Move', phone: '+254700000012', status: 'active',
    });
    houseA.tenantId = tenantA._id;
    houseA.status = 'occupied';
    await houseA.save();

    await expect(
      tenantService.moveToHouse(client._id, tenantA._id, houseB._id, [String(estateA._id)])
    ).rejects.toThrow();

    const still = await Tenant.findById(tenantA._id);
    expect(String(still.houseId)).toBe(String(houseA._id));
    expect(String(still.estateId)).toBe(String(estateA._id));
  });

  test('tenantService.moveToHouse rejects move from Estate B tenant when filter is Estate A only', async () => {
    const tenantB = await Tenant.create({
      clientId: client._id, estateId: estateB._id, houseId: houseB._id,
      name: 'Tenant B Move', phone: '+254700000013', status: 'active',
    });
    houseB.tenantId = tenantB._id;
    houseB.status = 'occupied';
    await houseB.save();

    await expect(
      tenantService.moveToHouse(client._id, tenantB._id, houseA._id, [String(estateA._id)])
    ).rejects.toThrow(Errors.TenantNotFound().message);
  });

  test('transactionService.assignToHouse rejects Estate B transaction or house under Estate A filter', async () => {
    const { Types } = await import('mongoose');
    const txnB = await BankTransaction.create({
      clientId: client._id,
      estateId: estateB._id,
      bankAccountId: new Types.ObjectId(),
      provider: 'COOP',
      providerTransactionId: `txn-b-${Date.now()}`,
      amountCents: 500000,
      currency: 'KES',
      eventType: 'CREDIT',
      matchStatus: 'UNMATCHED',
      transactionDate: new Date(),
    });

    await expect(
      transactionService.assignToHouse(client._id, txnB._id, houseA._id, [String(estateA._id)])
    ).rejects.toThrow();

    const txnA = await BankTransaction.create({
      clientId: client._id,
      estateId: estateA._id,
      bankAccountId: new Types.ObjectId(),
      provider: 'COOP',
      providerTransactionId: `txn-a-${Date.now()}`,
      amountCents: 400000,
      currency: 'KES',
      eventType: 'CREDIT',
      matchStatus: 'UNMATCHED',
      transactionDate: new Date(),
    });

    await expect(
      transactionService.assignToHouse(client._id, txnA._id, houseB._id, [String(estateA._id)])
    ).rejects.toThrow(Errors.HouseNotFound().message);
  });

  test('bankService.sync rejects Estate B account under Estate A filter; job-style null filter still loads by clientId', async () => {
    const accountB = await BankAccount.create({
      clientId: client._id,
      estateId: estateB._id,
      provider: 'COOP',
      accountName: 'Estate B Account',
      accountNumberEncrypted: 'enc',
      accountNumberHash: `hash-b-${Date.now()}`,
      currency: 'KES',
      connectionStatus: 'connected',
    });

    await expect(
      bankService.get(client._id, accountB._id, [String(estateA._id)])
    ).rejects.toThrow();

    // Global job path: no estateFilter → still retrieves by clientId alone
    const loaded = await bankService.get(client._id, accountB._id, null);
    expect(String(loaded._id)).toBe(String(accountB._id));
  });

  test('CLIENT_OWNER with null estateFilter can update houses in both estates', async () => {
    const a = await houseService.update(client._id, houseA._id, { monthlyRent: 12000 }, null);
    const b = await houseService.update(client._id, houseB._id, { monthlyRent: 22000 }, null);
    expect(a.monthlyRent).toBe(12000);
    expect(b.monthlyRent).toBe(22000);
  });

});
