/**
 * HTTP-level tests (supertest) for the backend P0 slice. No database is used:
 * authentication/context middlewares and Mongoose model statics are stubbed, the
 * real routers, validators, controllers and services run.
 */
import '../../setup.js';
import { jest } from '@jest/globals';
import express from 'express';
import request from 'supertest';
import mongoose from 'mongoose';

const CLIENT = new mongoose.Types.ObjectId();
const ESTATE = new mongoose.Types.ObjectId();
const OTHER_ESTATE = new mongoose.Types.ObjectId();
const HOUSE = new mongoose.Types.ObjectId();
const TENANT = new mongoose.Types.ObjectId();
const TENANCY = new mongoose.Types.ObjectId();
const USER = new mongoose.Types.ObjectId();

jest.unstable_mockModule('../../../src/middlewares/authenticate.js', () => ({
  authenticate: (req, _res, next) => { req.currentUser = { _id: USER, role: 'CLIENT_OWNER' }; next(); },
}));
jest.unstable_mockModule('../../../src/middlewares/clientContext.js', () => ({
  clientContext: (req, _res, next) => { req.clientId = CLIENT; req.estateFilter = null; next(); },
}));
jest.unstable_mockModule('../../../src/middlewares/requireProduct.js', () => ({
  requireProduct: () => (_req, _res, next) => next(),
}));
jest.unstable_mockModule('../../../src/services/audit.service.js', () => ({
  audit: jest.fn(async () => {}),
  auditRequired: jest.fn(async () => {}),
  listAuditLogs: jest.fn(async () => []),
}));
jest.unstable_mockModule('../../../src/utils/houseTypeIndexReadiness.js', () => ({
  inspectHouseTypeIndexes: jest.fn(async () => ({ aligned: true })),
  assertHouseTypeIndexesAligned: jest.fn(async () => {}),
}));

const { errorHandler } = await import('../../../src/middlewares/errorHandler.js');
const { default: transactionRoutes } = await import('../../../src/routes/transaction.routes.js');
const { default: houseTypeRoutes } = await import('../../../src/routes/houseType.routes.js');
const { BankTransaction } = await import('../../../src/models/BankTransaction.js');
const { House } = await import('../../../src/models/House.js');
const { Tenant } = await import('../../../src/models/Tenant.js');
const { Estate } = await import('../../../src/models/Estate.js');
const { HouseType } = await import('../../../src/models/HouseType.js');
const { tenancyService } = await import('../../../src/services/tenancy.service.js');
const { reconciliationService } = await import('../../../src/services/reconciliation.service.js');
const { houseTypeService } = await import('../../../src/services/houseType.service.js');

const app = express();
app.use(express.json());
app.use('/api/v1/transactions', transactionRoutes);
app.use('/api/v1/house-types', houseTypeRoutes);
app.use(errorHandler);

const FORBIDDEN = [
  'rawPayload', 'processingClaimToken', 'processingClaimExpiresAt', 'processingAttempts', 'lastProcessingError',
  'rawReference', 'connectionId', 'bookedBalanceCents', 'clearedBalanceCents', 'schemaUnverified', 'sourceChannel',
];
const LEAK_MARKERS = ['SECRET-CLAIM-TOKEN', 'SECRET-PAYLOAD', 'boom-internal-error'];

const dirty = (extra = {}) => ({
  _id: new mongoose.Types.ObjectId(), clientId: CLIENT, estateId: ESTATE, bankAccountId: new mongoose.Types.ObjectId(),
  connectionId: new mongoose.Types.ObjectId(), provider: 'COOP', providerTransactionId: 'T-1', amountCents: 150000,
  currency: 'KES', transactionDate: new Date('2026-06-05'), paymentReference: 'REF1', narration: 'rent',
  eventType: 'CREDIT', matchStatus: 'UNMATCHED', processingState: 'RECEIVED',
  rawReference: 'raw', bookedBalanceCents: 1, clearedBalanceCents: 2, sourceChannel: 'poll', schemaUnverified: false,
  processingClaimToken: 'SECRET-CLAIM-TOKEN', processingClaimExpiresAt: new Date(), processingAttempts: 4,
  lastProcessingError: 'boom-internal-error', rawPayload: { secret: 'SECRET-PAYLOAD' }, ...extra,
});
const chain = (result) => {
  const c = { sort: () => c, skip: () => c, limit: () => c, lean: () => c, then: (res, rej) => Promise.resolve(result).then(res, rej) };
  return c;
};
function expectNoLeak(res) {
  const text = JSON.stringify(res.body);
  for (const m of LEAK_MARKERS) expect(text).not.toContain(m);
  const walk = (v) => {
    if (Array.isArray(v)) return v.forEach(walk);
    if (v && typeof v === 'object') { for (const k of Object.keys(v)) { expect(FORBIDDEN).not.toContain(k); walk(v[k]); } }
  };
  walk(res.body);
}

afterEach(() => jest.restoreAllMocks());

describe('BankTransaction responses never expose internals', () => {
  test('GET /transactions (list)', async () => {
    jest.spyOn(BankTransaction, 'find').mockReturnValue(chain([dirty(), dirty()]));
    jest.spyOn(BankTransaction, 'countDocuments').mockResolvedValue(2);
    const res = await request(app).get('/api/v1/transactions');
    expect(res.status).toBe(200);
    const items = res.body.data.items;
    expect(items).toHaveLength(2);
    expect(items[0].amountCents).toBe(150000);
    expect(items[0].matchStatus).toBe('UNMATCHED');
    expectNoLeak(res);
    for (const k of ['rawPayload', 'processingClaimToken', 'processingClaimExpiresAt', 'processingAttempts', 'lastProcessingError']) {
      expect(items[0]).not.toHaveProperty(k);
    }
  });

  test('GET /transactions/unmatched', async () => {
    jest.spyOn(BankTransaction, 'find').mockReturnValue(chain([dirty()]));
    const res = await request(app).get('/api/v1/transactions/unmatched');
    expect(res.status).toBe(200);
    expect(res.body.data).toHaveLength(1);
    expect(res.body.data[0].providerTransactionId).toBe('T-1');
    expectNoLeak(res);
  });

  test('POST /transactions/:id/assign', async () => {
    const doc = new BankTransaction(dirty({ estateId: ESTATE }));
    jest.spyOn(BankTransaction, 'findOne').mockResolvedValue(doc);
    jest.spyOn(BankTransaction, 'updateOne').mockResolvedValue({ matchedCount: 1 });
    jest.spyOn(House, 'findOne').mockResolvedValue({ _id: HOUSE, estateId: ESTATE, houseNumber: 'A1' });
    jest.spyOn(tenancyService, 'findUniqueForHouseAt').mockResolvedValue({ _id: TENANCY, estateId: ESTATE, houseId: HOUSE, tenantId: TENANT });
    jest.spyOn(Tenant, 'findOne').mockResolvedValue({ _id: TENANT, name: 'T', phone: null });
    jest.spyOn(mongoose, 'startSession').mockResolvedValue({ withTransaction: async (cb) => cb(), endSession: async () => {} });
    jest.spyOn(reconciliationService, 'applyPayment').mockResolvedValue({ remainingBalanceCents: 0 });
    const res = await request(app).post(`/api/v1/transactions/${doc._id}/assign`).send({ houseId: String(HOUSE) });
    expect(res.status).toBe(200);
    expect(res.body.data.matchStatus).toBe('MATCHED');
    expect(String(res.body.data.matchedTenancyId)).toBe(String(TENANCY));
    expect(reconciliationService.applyPayment).toHaveBeenCalledTimes(1);
    expectNoLeak(res);
    for (const k of ['rawPayload', 'processingClaimToken', 'processingClaimExpiresAt', 'processingAttempts', 'lastProcessingError']) {
      expect(res.body.data).not.toHaveProperty(k);
    }
  });
});

describe('HouseType HTTP contract', () => {
  const body = { name: '1BR', defaultRentCents: 100000 };

  test('POST without estateId fails validation and never reaches the service', async () => {
    const spy = jest.spyOn(houseTypeService, 'create').mockResolvedValue({ _id: 'x' });
    const res = await request(app).post('/api/v1/house-types').send(body);
    expect(res.status).toBe(422);
    expect(res.body.error.code).toBe('INVALID_REQUEST');
    expect(spy).not.toHaveBeenCalled();
  });

  test('POST with a valid estateId delivers it to the service', async () => {
    const spy = jest.spyOn(houseTypeService, 'create').mockResolvedValue({ _id: 'x' });
    const res = await request(app).post('/api/v1/house-types').send({ ...body, estateId: String(ESTATE) });
    expect(res.status).toBe(201);
    expect(spy).toHaveBeenCalledTimes(1);
    expect(String(spy.mock.calls[0][1].estateId)).toBe(String(ESTATE));
  });

  test('an estate belonging to another client is rejected (404, nothing created)', async () => {
    const find = jest.spyOn(Estate, 'findOne').mockReturnValue(chain(null));
    const create = jest.spyOn(HouseType, 'create');
    const res = await request(app).post('/api/v1/house-types').send({ ...body, estateId: String(OTHER_ESTATE) });
    expect(res.status).toBe(404);
    expect(res.body.error.code).toBe('ESTATE_NOT_FOUND');
    expect(find).toHaveBeenCalledWith({ _id: String(OTHER_ESTATE), clientId: CLIENT });
    expect(create).not.toHaveBeenCalled();
  });

  test('PATCH that tries to move the HouseType to another estate is rejected and saves nothing', async () => {
    const save = jest.fn();
    const type = { _id: new mongoose.Types.ObjectId(), clientId: CLIENT, estateId: ESTATE, save };
    jest.spyOn(mongoose, 'startSession').mockResolvedValue({ withTransaction: async (cb) => cb(), endSession: async () => {} });
    jest.spyOn(HouseType, 'findOne').mockReturnValue({ session: () => Promise.resolve(type) });
    const res = await request(app).patch(`/api/v1/house-types/${type._id}`).send({ estateId: String(OTHER_ESTATE), name: 'X' });
    expect(res.status).toBe(422);
    expect(res.body.error.message).toMatch(/cannot move between Estates/);
    expect(save).not.toHaveBeenCalled();
  });

  test('PATCH with a malformed estateId fails validation', async () => {
    const res = await request(app).patch('/api/v1/house-types/64b7f0a1c2d3e4f5a6b7c8d9').send({ estateId: 'bad' });
    expect(res.status).toBe(422);
  });
});
