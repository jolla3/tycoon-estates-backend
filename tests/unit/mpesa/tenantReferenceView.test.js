// Logic-level (mocked persistence). Estate/client boundary against a real database is covered by
// tests/integration/g54.sharedPaybill.test.js (NOT EXECUTED in this environment).
import '../../setup.js';
import { jest } from '@jest/globals';
import mongoose from 'mongoose';

const loadScopedTenant = jest.fn();
const issueRef = jest.fn();
const tenancyFind = jest.fn(); const tenancyCount = jest.fn(); const tenancyFindOne = jest.fn();
const mappingFind = jest.fn(); const profileFind = jest.fn(); const houseFind = jest.fn();
const refFind = jest.fn(); const refAgg = jest.fn();
const lean = (v) => ({ select: () => lean(v), sort: () => lean(v), skip: () => lean(v), limit: () => lean(v), lean: async () => v });

jest.unstable_mockModule('../../../src/services/tenantAccount.service.js', () => ({ loadScopedTenant, tenantAccountService: {} }));
jest.unstable_mockModule('../../../src/services/mpesa/mpesaReference.service.js', () => ({ mpesaReferenceService: { issue: issueRef } }));
jest.unstable_mockModule('../../../src/models/Tenancy.js', () => ({ Tenancy: { find: tenancyFind, countDocuments: tenancyCount, findOne: (f) => ({ lean: async () => tenancyFindOne(f) }) } }));
jest.unstable_mockModule('../../../src/models/MpesaMerchantProfileEstate.js', () => ({ MpesaMerchantProfileEstate: { find: mappingFind } }));
jest.unstable_mockModule('../../../src/models/MpesaMerchantProfile.js', () => ({ MpesaMerchantProfile: { find: profileFind } }));
jest.unstable_mockModule('../../../src/models/House.js', () => ({ House: { find: houseFind } }));
jest.unstable_mockModule('../../../src/models/MpesaCollectionReference.js', () => ({ MpesaCollectionReference: { find: refFind, aggregate: refAgg } }));

const { mpesaTenantReferenceService: svc } = await import('../../../src/services/mpesa/mpesaTenantReference.service.js');
const { issueTenantReferenceSchema, referencesQuerySchema } = await import('../../../src/routes/mpesaCollection.routes.js');

const id = () => new mongoose.Types.ObjectId();
const CLIENT = id(); const TENANT = id(); const E1 = id(); const E2 = id(); const H1 = id(); const H2 = id();
const T_ACTIVE = id(); const T_CLOSED = id(); const P1 = id();

beforeEach(() => {
  [loadScopedTenant, issueRef, tenancyFind, tenancyCount, tenancyFindOne, mappingFind, profileFind, houseFind, refFind, refAgg].forEach((m) => m.mockReset());
  loadScopedTenant.mockResolvedValue({ _id: TENANT, estateId: E1 });
  tenancyFind.mockReturnValue(lean([
    { _id: T_ACTIVE, estateId: E1, houseId: H1, status: 'ACTIVE', startAt: new Date('2026-05-01'), endAt: null },
    { _id: T_CLOSED, estateId: E2, houseId: H2, status: 'CLOSED', startAt: new Date('2025-01-01'), endAt: new Date('2026-04-01') },
  ]));
  tenancyCount.mockResolvedValue(2);
  mappingFind.mockReturnValue(lean([{ merchantProfileId: P1, estateId: E1 }, { merchantProfileId: P1, estateId: E2 }]));
  profileFind.mockReturnValue(lean([{ _id: P1, displayName: 'Main PayBill', businessShortCode: '123456', secret: 'x' }]));
  houseFind.mockReturnValue(lean([{ _id: H1, houseNumber: 'A1' }, { _id: H2, houseNumber: 'B2' }]));
});

describe('tenant reference view: exact tenancy identity, retired distinguished', () => {
  test('returns one entry per tenancy with its own active/retired references; no default tenancy', async () => {
    refFind.mockReturnValue(lean([{ _id: id(), tenancyId: T_ACTIVE, merchantProfileId: P1, reference: 'T1234567890', status: 'ACTIVE', createdAt: new Date() }]));
    refAgg.mockResolvedValue([{ _id: { t: T_CLOSED, m: P1 }, count: 7, recent: [{ _id: id(), reference: 'TABCDEFGH1', status: 'RETIRED', retiredAt: new Date(), retiredReason: 'TENANCY_CLOSED' }] }]);
    const out = await svc.view({ clientId: CLIENT, estateFilter: null, tenantId: TENANT });
    expect(out.tenancies.map((t) => t.tenancyId)).toEqual([String(T_ACTIVE), String(T_CLOSED)]);
    expect(out).not.toHaveProperty('defaultTenancyId');
    const [a, c] = out.tenancies;
    expect(a.merchants[0].active).toMatchObject({ reference: 'T1234567890', display: 'T1234-5678-0' });
    expect(a.merchants[0].canIssue).toBe(false);
    expect(a.merchants[0].retired).toEqual([]);
    expect(c.merchants[0].active).toBeNull();
    expect(c.merchants[0].retired[0]).toMatchObject({ retiredReason: 'TENANCY_CLOSED' });
    expect(c.merchants[0].retiredCount).toBe(7);
    expect(c.merchants[0].canIssue).toBe(false); // closed tenancy can never be issued a new reference
    expect(JSON.stringify(out)).not.toContain('secret');
  });

  test('queries are scoped by client, tenant, the caller estate set, and the page tenancies only', async () => {
    refFind.mockReturnValue(lean([])); refAgg.mockResolvedValue([]);
    await svc.view({ clientId: CLIENT, estateFilter: [String(E1)], tenantId: TENANT });
    expect(tenancyFind.mock.calls[0][0]).toMatchObject({ clientId: CLIENT, tenantId: TENANT, estateId: { $in: [String(E1)] } });
    expect(refFind.mock.calls[0][0]).toMatchObject({ clientId: CLIENT, tenantId: TENANT, status: 'ACTIVE' });
    expect(refFind.mock.calls[0][0].tenancyId.$in).toEqual([T_ACTIVE, T_CLOSED]);
    expect(String(refAgg.mock.calls[0][0][0].$match.tenantId)).toBe(String(TENANT));
  });

  test('a tenant outside the caller scope is not found (nothing disclosed)', async () => {
    loadScopedTenant.mockRejectedValue(Object.assign(new Error('Tenant not found'), { status: 404 }));
    await expect(svc.view({ clientId: CLIENT, estateFilter: [String(E2)], tenantId: TENANT })).rejects.toMatchObject({ status: 404 });
    expect(tenancyFind).not.toHaveBeenCalled();
    expect(refFind).not.toHaveBeenCalled();
  });

  test('a merchant mapped only to another estate is not shown for this tenancy', async () => {
    mappingFind.mockReturnValue(lean([{ merchantProfileId: P1, estateId: E2 }]));
    refFind.mockReturnValue(lean([])); refAgg.mockResolvedValue([]);
    const out = await svc.view({ clientId: CLIENT, estateFilter: null, tenantId: TENANT });
    expect(out.tenancies[0].merchants).toEqual([]);
    expect(out.tenancies[1].merchants).toHaveLength(1);
  });
});

describe('issue for one explicit tenancy', () => {
  test('a tenancy that is not this tenant\'s (or out of scope) is 404 and nothing is issued', async () => {
    tenancyFindOne.mockReturnValue(null);
    await expect(svc.issue({ clientId: CLIENT, estateFilter: null, tenantId: TENANT, tenancyId: T_ACTIVE, merchantProfileId: P1, actor: { _id: 'u' } })).rejects.toMatchObject({ status: 404 });
    expect(tenancyFindOne.mock.calls[0][0]).toMatchObject({ _id: T_ACTIVE, clientId: CLIENT, tenantId: TENANT });
    expect(issueRef).not.toHaveBeenCalled();
  });
  test('issues for exactly that tenancy and returns only that reference', async () => {
    tenancyFindOne.mockReturnValue({ _id: T_ACTIVE, tenantId: TENANT, estateId: E1 });
    issueRef.mockResolvedValue({ created: true, reference: { _id: id(), tenantId: TENANT, tenancyId: T_ACTIVE, reference: 'T1234567890', status: 'ACTIVE', createdAt: new Date() } });
    const out = await svc.issue({ clientId: CLIENT, estateFilter: null, tenantId: TENANT, tenancyId: T_ACTIVE, merchantProfileId: P1, actor: { _id: 'u' } });
    expect(issueRef.mock.calls[0][0]).toMatchObject({ tenancyId: T_ACTIVE, merchantProfileId: P1, clientId: CLIENT });
    expect(out.reference.display).toBe('T1234-5678-0');
  });
  test('defence in depth: a reference that belongs to another tenancy is never returned', async () => {
    tenancyFindOne.mockReturnValue({ _id: T_ACTIVE, tenantId: TENANT, estateId: E1 });
    issueRef.mockResolvedValue({ created: false, reference: { _id: id(), tenantId: id(), tenancyId: T_ACTIVE, reference: 'T1234567890' } });
    await expect(svc.issue({ clientId: CLIENT, estateFilter: null, tenantId: TENANT, tenancyId: T_ACTIVE, merchantProfileId: P1, actor: { _id: 'u' } })).rejects.toMatchObject({ status: 409 });
  });
});

describe('request schemas', () => {
  test('strict ids; unknown keys rejected; page bounds', () => {
    const ok = { tenancyId: String(T_ACTIVE), merchantProfileId: String(P1) };
    expect(issueTenantReferenceSchema.safeParse(ok).success).toBe(true);
    expect(issueTenantReferenceSchema.safeParse({ ...ok, clientId: 'x' }).success).toBe(false);
    expect(issueTenantReferenceSchema.safeParse({ tenancyId: 'nope', merchantProfileId: ok.merchantProfileId }).success).toBe(false);
    expect(referencesQuerySchema.safeParse({ limit: '50' }).success).toBe(false);
    expect(referencesQuerySchema.safeParse({ page: '2', limit: '10' }).success).toBe(true);
  });
});
