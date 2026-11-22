/**
 * Explicit tenant/house/tenancy/date ownership for manual payments (no database).
 * Collaborators are stubbed so each test asserts WHICH checks run and that the explicit
 * tenant is never silently replaced by the house's current occupant.
 */
import '../setup.js';
import { jest } from '@jest/globals';
import mongoose from 'mongoose';

jest.unstable_mockModule('../../src/config/database.js', () => ({
  connectDatabase: jest.fn(), disconnectDatabase: jest.fn(), isDatabaseReady: jest.fn(() => true),
  verifyMongoTransactionSupport: jest.fn(async () => true), supportsMongoTransactions: jest.fn(() => true),
}));
jest.unstable_mockModule('../../src/services/audit.service.js', () => ({
  audit: jest.fn(async () => {}), auditRequired: jest.fn(), listAuditLogs: jest.fn(),
}));

const { tenancyService } = await import('../../src/services/tenancy.service.js');
const { Tenancy } = await import('../../src/models/Tenancy.js');
const { Tenant } = await import('../../src/models/Tenant.js');
const { dateUtil } = await import('../../src/utils/date.js');

const oid = () => new mongoose.Types.ObjectId();
const CLIENT = oid(); const ESTATE = oid(); const HOUSE = oid();
const T_OLD = oid(); const T_NOW = oid();
const house = { _id: HOUSE, estateId: ESTATE, houseNumber: '78' };

const old = { _id: oid(), clientId: CLIENT, estateId: ESTATE, houseId: HOUSE, tenantId: T_OLD, status: 'CLOSED',
  startAt: new Date('2026-01-01T00:00:00+03:00'), endAt: new Date('2026-07-01T00:00:00+03:00') };
const now = { _id: oid(), clientId: CLIENT, estateId: ESTATE, houseId: HOUSE, tenantId: T_NOW, status: 'ACTIVE',
  startAt: new Date('2026-07-01T00:00:00+03:00'), endAt: null };

const chain = (result) => { const c = { session: () => c, lean: () => c, then: (r, j) => Promise.resolve(result).then(r, j) }; return c; };
const day = (d) => dateUtil.parseNairobiDateOnly(d);

/** Emulates the DB: findOne filtered by the exact query keys the service sends. */
function stubTenancies(rows, tenants = [{ _id: T_OLD, clientId: CLIENT, estateId: ESTATE }, { _id: T_NOW, clientId: CLIENT, estateId: ESTATE }]) {
  const match = (q, r) => Object.entries(q).every(([k, v]) => String(r[k]) === String(v));
  jest.spyOn(Tenancy, 'findOne').mockImplementation((q) => chain(rows.find((r) => match(q, r)) || null));
  jest.spyOn(Tenant, 'findOne').mockImplementation((q) => chain(tenants.find((r) => match(q, r)) || null));
}
afterEach(() => jest.restoreAllMocks());

const resolve = (ids, d) => tenancyService.resolveExplicitForManualPayment(CLIENT, house, ids, day(d));

describe('resolveExplicitForManualPayment', () => {
  test('backdated payment goes to the FORMER occupant, not the current one', async () => {
    stubTenancies([old, now]);
    const r = await resolve({ tenantId: T_OLD, tenancyId: old._id }, '2026-03-10');
    expect(String(r.tenancy.tenantId)).toBe(String(T_OLD));
    expect(String(r.tenant._id)).toBe(String(T_OLD));
  });

  test('current occupant on a current date is accepted', async () => {
    stubTenancies([old, now]);
    const r = await resolve({ tenantId: T_NOW, tenancyId: now._id }, '2026-08-15');
    expect(String(r.tenancy._id)).toBe(String(now._id));
  });

  test('explicit former tenant is never replaced by the current occupant (contradictory ids rejected)', async () => {
    stubTenancies([old, now]);
    await expect(resolve({ tenantId: T_NOW, tenancyId: old._id }, '2026-03-10')).rejects.toMatchObject({ code: 'INVALID_REQUEST' });
    await expect(resolve({ tenantId: T_OLD, tenancyId: now._id }, '2026-08-15')).rejects.toMatchObject({ code: 'INVALID_REQUEST' });
  });

  test('tenancy that does not cover the payment date is rejected', async () => {
    stubTenancies([old, now]);
    // old ended 2026-07-01; now started 2026-07-01
    await expect(resolve({ tenantId: T_OLD, tenancyId: old._id }, '2026-09-01')).rejects.toMatchObject({ message: expect.stringMatching(/did not cover/) });
    await expect(resolve({ tenantId: T_NOW, tenancyId: now._id }, '2026-06-30')).rejects.toMatchObject({ message: expect.stringMatching(/did not cover/) });
  });

  test('tenancy end is exclusive and start day is inclusive (Nairobi days)', async () => {
    stubTenancies([old, now]);
    await expect(resolve({ tenantId: T_OLD, tenancyId: old._id }, '2026-06-30')).resolves.toBeDefined();
    await expect(resolve({ tenantId: T_NOW, tenancyId: now._id }, '2026-07-01')).resolves.toBeDefined();
    await expect(resolve({ tenantId: T_OLD, tenancyId: old._id }, '2026-07-01')).rejects.toMatchObject({ code: 'INVALID_REQUEST' });
  });

  test('tenancy of another house/estate/client resolves to nothing and is rejected; lookup is scoped', async () => {
    const spy = jest.spyOn(Tenancy, 'findOne').mockReturnValue(chain(null));
    jest.spyOn(Tenant, 'findOne').mockReturnValue(chain(null));
    await expect(resolve({ tenantId: T_OLD, tenancyId: oid() }, '2026-03-10')).rejects.toMatchObject({ code: 'INVALID_REQUEST' });
    expect(spy.mock.calls[0][0]).toMatchObject({ clientId: CLIENT, houseId: HOUSE, estateId: ESTATE });
  });

  test('tenant outside the client/estate is rejected even with a consistent tenancy', async () => {
    stubTenancies([old], []); // tenant missing from this client+estate
    await expect(resolve({ tenantId: T_OLD, tenancyId: old._id }, '2026-03-10')).rejects.toMatchObject({ code: 'INVALID_REQUEST' });
  });

  test('VOID tenancy is invalid', async () => {
    stubTenancies([{ ...old, status: 'VOID' }]);
    await expect(resolve({ tenantId: T_OLD, tenancyId: old._id }, '2026-03-10')).rejects.toMatchObject({ message: expect.stringMatching(/not valid for payments/) });
  });

  test('missing ids are rejected before any lookup', async () => {
    const spy = jest.spyOn(Tenancy, 'findOne');
    await expect(resolve({ tenantId: T_OLD }, '2026-03-10')).rejects.toMatchObject({ code: 'INVALID_REQUEST' });
    await expect(resolve({ tenancyId: old._id }, '2026-03-10')).rejects.toMatchObject({ code: 'INVALID_REQUEST' });
    expect(spy).not.toHaveBeenCalled();
  });

  test('identity mismatches share one generic message (ids cannot be probed)', async () => {
    stubTenancies([old, now]);
    const e1 = await resolve({ tenantId: T_NOW, tenancyId: old._id }, '2026-03-10').catch((e) => e);
    const e2 = await resolve({ tenantId: T_OLD, tenancyId: oid() }, '2026-03-10').catch((e) => e);
    expect(e1.message).toBe(e2.message);
  });
});
