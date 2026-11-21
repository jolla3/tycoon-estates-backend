/**
 * recordManual orchestration without a database: every collaborator is stubbed so the
 * test can assert WHICH tenancy/session/source reference each step receives.
 * (Atomic rollback itself needs MongoDB: see tests/integration/manualPayment.tenancy.test.js.)
 */
import '../setup.js';
import { jest } from '@jest/globals';
import mongoose from 'mongoose';

jest.unstable_mockModule('../../src/config/database.js', () => ({
  connectDatabase: jest.fn(), disconnectDatabase: jest.fn(), isDatabaseReady: jest.fn(() => true),
  verifyMongoTransactionSupport: jest.fn(async () => true), supportsMongoTransactions: jest.fn(() => true),
}));
const auditMock = jest.fn(async () => {});
jest.unstable_mockModule('../../src/services/audit.service.js', () => ({
  audit: auditMock, auditRequired: jest.fn(), listAuditLogs: jest.fn(),
}));

const { supportsMongoTransactions } = await import('../../src/config/database.js');
const { paymentService } = await import('../../src/services/payment.service.js');
const { tenancyService } = await import('../../src/services/tenancy.service.js');
const { rentService } = await import('../../src/services/rent.service.js');
const { accountingPostingService } = await import('../../src/services/accountingPosting.service.js');
const { House } = await import('../../src/models/House.js');
const { Tenancy } = await import('../../src/models/Tenancy.js');
const { isTenancyEligibleForPeriod } = await import('../../src/utils/tenancyEligibility.js');

// The service now sends the exact eligibility predicate to the database. Emulate the database by
// applying the same single rule to the fixture list for the fixed test period.
const DB_PERIOD = '2026-06';
const fakeFind = (list) => (filter = {}) => chain(list.filter((t) =>
  (!filter.startAt || isTenancyEligibleForPeriod(t, DB_PERIOD))
  && (!filter.tenantId || String(t.tenantId) === String(filter.tenantId))));

const oid = () => new mongoose.Types.ObjectId();
const CLIENT = oid(); const ESTATE = oid(); const HOUSE = oid();
const TENANT_OLD = oid(); const TENANT_NOW = oid();
const tenancyOld = { _id: oid(), clientId: CLIENT, estateId: ESTATE, houseId: HOUSE, tenantId: TENANT_OLD, status: 'CLOSED', startAt: new Date('2026-01-01T00:00:00+03:00'), endAt: new Date('2026-07-01T00:00:00+03:00') };
const tenancyNow = { _id: oid(), clientId: CLIENT, estateId: ESTATE, houseId: HOUSE, tenantId: TENANT_NOW, status: 'ACTIVE', startAt: new Date('2026-07-01T00:00:00+03:00'), endAt: null };

// A house whose CURRENT tenant must never be consulted.
function houseWithTrapTenant() {
  const h = { _id: HOUSE, estateId: ESTATE, houseNumber: 'A1' };
  Object.defineProperty(h, 'tenantId', { get() { throw new Error('house.tenantId must not be read'); } });
  return h;
}
const chain = (result) => { const c = { session: () => c, lean: () => c, sort: () => c, limit: (n) => { if (Array.isArray(result)) result = result.slice(0, n); return c; }, then: (res, rej) => Promise.resolve(result).then(res, rej) }; return c; };
const fakeSession = { id: 'S' };
const ok = () => ({ withTransaction: async (cb) => cb(), endSession: jest.fn(async () => {}) });

beforeEach(() => {
  supportsMongoTransactions.mockReturnValue(true);
  auditMock.mockClear();
  jest.spyOn(House, 'findOne').mockResolvedValue(houseWithTrapTenant());
  jest.spyOn(mongoose, 'startSession').mockResolvedValue({ ...ok(), ...fakeSession });
});
afterEach(() => jest.restoreAllMocks());

const body = { houseId: String(HOUSE), amountCents: 500000, period: '2026-06', paymentReference: 'R-1' };

describe('recordManual routes one validated tenancy through every step', () => {
  test('historic tenancy: same tenancy/tenant/session reach charges, outstanding, posting; current tenant ignored', async () => {
    jest.spyOn(Tenancy, 'find').mockImplementation(fakeFind([tenancyOld, tenancyNow]));
    const charges = [{ _id: oid(), tenancyId: tenancyOld._id }];
    const ensure = jest.spyOn(rentService, 'ensureChargesForTenancy').mockResolvedValue([]);
    const outstanding = jest.spyOn(rentService, 'outstandingChargesForTenancy').mockResolvedValue(charges);
    const post = jest.spyOn(accountingPostingService, 'postConfirmedPayment').mockResolvedValue({
      payment: { _id: oid(), tenancyId: tenancyOld._id }, allocations: [], reused: false, unappliedCents: 0,
    });

    const res = await paymentService.recordManual(CLIENT, body, null, { _id: oid() }, { ip: '1.1.1.1' });

    const sessionPassed = ensure.mock.calls[0][4].session;
    expect(sessionPassed).toBeDefined();
    expect(ensure).toHaveBeenCalledWith(CLIENT, tenancyOld, expect.anything(), '2026-06', { session: sessionPassed });
    expect(outstanding).toHaveBeenCalledWith(CLIENT, tenancyOld._id, { session: sessionPassed });
    expect(post).toHaveBeenCalledTimes(1);
    const [input, opts] = post.mock.calls[0];
    expect(opts.session).toBe(sessionPassed);
    expect(input).toMatchObject({
      clientId: CLIENT, estateId: ESTATE, houseId: HOUSE, tenancyId: tenancyOld._id, tenantId: TENANT_OLD,
      origin: 'MANUAL', amountCents: 500000, paymentReference: 'R-1', period: '2026-06',
    });
    expect(input.charges).toBe(charges);
    expect(res.reused).toBe(false);
    expect(auditMock).toHaveBeenCalledWith(expect.objectContaining({
      action: 'PAYMENT_RECORDED', metadata: expect.objectContaining({ tenancyId: String(tenancyOld._id), period: '2026-06' }),
    }));
  });

  test('ambiguous resolution: nothing is generated or posted; explicit tenancyId is demanded', async () => {
    const second = { ...tenancyOld, _id: oid(), tenantId: oid() };
    jest.spyOn(Tenancy, 'find').mockImplementation(fakeFind([tenancyOld, second]));
    const ensure = jest.spyOn(rentService, 'ensureChargesForTenancy');
    const post = jest.spyOn(accountingPostingService, 'postConfirmedPayment');
    await expect(paymentService.recordManual(CLIENT, body)).rejects.toMatchObject({ code: 'CONFLICT', message: expect.stringMatching(/choose which tenancy/) });
    expect(ensure).not.toHaveBeenCalled();
    expect(post).not.toHaveBeenCalled();
    expect(auditMock).not.toHaveBeenCalled();
  });

  test('no eligible tenancy: rejected, nothing posted', async () => {
    jest.spyOn(Tenancy, 'find').mockImplementation(fakeFind([tenancyNow])); // starts 2026-07, period is 2026-06
    const post = jest.spyOn(accountingPostingService, 'postConfirmedPayment');
    await expect(paymentService.recordManual(CLIENT, body)).rejects.toMatchObject({ code: 'INVALID_REQUEST' });
    expect(post).not.toHaveBeenCalled();
  });

  test('explicit tenancy of another house/client resolves to nothing and is rejected', async () => {
    const find = jest.spyOn(Tenancy, 'findOne').mockReturnValue(chain(null));
    const post = jest.spyOn(accountingPostingService, 'postConfirmedPayment');
    await expect(paymentService.recordManual(CLIENT, { ...body, tenancyId: String(oid()) }))
      .rejects.toMatchObject({ code: 'INVALID_REQUEST', message: expect.stringMatching(/does not belong to this house/) });
    // The lookup itself is scoped by client, house AND estate.
    expect(find.mock.calls[0][0]).toMatchObject({ clientId: CLIENT, houseId: HOUSE, estateId: ESTATE });
    expect(post).not.toHaveBeenCalled();
  });

  test('tenantId that does not match the explicitly selected tenancy is rejected', async () => {
    jest.spyOn(Tenancy, 'findOne').mockReturnValue(chain(tenancyOld));
    const post = jest.spyOn(accountingPostingService, 'postConfirmedPayment');
    await expect(paymentService.recordManual(CLIENT, { ...body, tenancyId: String(tenancyOld._id), tenantId: String(TENANT_NOW) }))
      .rejects.toMatchObject({ code: 'INVALID_REQUEST', message: expect.stringMatching(/different tenant/) });
    expect(post).not.toHaveBeenCalled();
  });

  test('tenantId that matches no covering tenancy (but one exists for someone else) is rejected specifically', async () => {
    jest.spyOn(Tenancy, 'find').mockImplementation(fakeFind([tenancyOld]));
    await expect(paymentService.recordManual(CLIENT, { ...body, tenantId: String(TENANT_NOW) }))
      .rejects.toMatchObject({ code: 'INVALID_REQUEST', message: expect.stringMatching(/tenantId does not match/) });
  });

  test('explicit tenancy that does not cover the period is rejected with the reason', async () => {
    jest.spyOn(Tenancy, 'findOne').mockReturnValue(chain(tenancyNow));
    await expect(paymentService.recordManual(CLIENT, { ...body, tenancyId: String(tenancyNow._id) }))
      .rejects.toMatchObject({ code: 'INVALID_REQUEST', message: expect.stringMatching(/began after/) });
  });

  test('a failure while posting propagates, skips the audit and ends the session', async () => {
    jest.spyOn(Tenancy, 'find').mockImplementation(fakeFind([tenancyOld]));
    jest.spyOn(rentService, 'ensureChargesForTenancy').mockResolvedValue([]);
    jest.spyOn(rentService, 'outstandingChargesForTenancy').mockResolvedValue([]);
    jest.spyOn(accountingPostingService, 'postConfirmedPayment').mockRejectedValue(new Error('ledger down'));
    const session = { ...ok() };
    mongoose.startSession.mockResolvedValue(session);
    await expect(paymentService.recordManual(CLIENT, body)).rejects.toThrow('ledger down');
    expect(session.endSession).toHaveBeenCalled();
    expect(auditMock).not.toHaveBeenCalled();
  });

  test('without transaction support it fails closed before touching anything', async () => {
    supportsMongoTransactions.mockReturnValue(false);
    const find = jest.spyOn(Tenancy, 'find');
    await expect(paymentService.recordManual(CLIENT, body)).rejects.toMatchObject({ code: 'SERVICE_UNAVAILABLE' });
    expect(find).not.toHaveBeenCalled();
  });

  test('validates amount and date before any lookup', async () => {
    await expect(paymentService.recordManual(CLIENT, { ...body, amountCents: 0 })).rejects.toMatchObject({ code: 'INVALID_REQUEST' });
    await expect(paymentService.recordManual(CLIENT, { ...body, paymentDate: 'nope' })).rejects.toMatchObject({ code: 'INVALID_REQUEST' });
    expect(House.findOne).not.toHaveBeenCalled();
  });
});
