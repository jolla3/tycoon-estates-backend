/**
 * Exact-Tenancy resolution + paid-requirement lock for the deposit service.
 * Models are replaced with an in-memory fake so these run without MongoDB.
 * They prove the resolution/conflict logic only; transactional behaviour and
 * concurrency are covered by the guarded replica-set suite
 * (tests/integration/depositExactTenancy.behavior.test.js).
 */
import '../setup.js';
import { jest } from '@jest/globals';

const oid = (n) => String(n).padStart(24, '0');
const CLIENT = oid(1); const OTHER_CLIENT = oid(2);
const EST_A = oid(10); const EST_B = oid(11);
const T1 = oid(21); const T2 = oid(22);

const db = { tenants: [], tenancies: [], deposits: [], audits: [] };

function matches(doc, q) {
  return Object.entries(q).every(([k, v]) => {
    if (v && typeof v === 'object' && '$in' in v) return v.$in.map(String).includes(String(doc[k]));
    return String(doc[k]) === String(v);
  });
}
function chain(rows) {
  const c = {
    sort: () => c, limit: (n) => { rows = rows.slice(0, n); return c; },
    session: () => c, lean: () => c, select: () => c,
    then: (res, rej) => Promise.resolve(rows).then(res, rej),
  };
  return c;
}
const single = (rows) => { const c = chain(rows.slice(0, 1)); c.then = (res, rej) => Promise.resolve(rows[0] || null).then(res, rej); return c; };

jest.unstable_mockModule('../../src/models/Tenant.js', () => ({
  Tenant: { findOne: (q) => single(db.tenants.filter((d) => matches(d, q))) },
}));
jest.unstable_mockModule('../../src/models/Tenancy.js', () => ({
  Tenancy: {
    find: (q) => chain(db.tenancies.filter((d) => matches(d, q))),
    findOne: (q) => single(db.tenancies.filter((d) => matches(d, q))),
    countDocuments: async (q) => db.tenancies.filter((d) => matches(d, q)).length,
  },
}));
jest.unstable_mockModule('../../src/models/Deposit.js', () => ({
  Deposit: {
    findOne: (q) => single(db.deposits.filter((d) => matches(d, q))),
    create: async (docs) => docs.map((d) => { const r = { _id: oid(900 + db.deposits.length), save: async () => {}, ...d }; db.deposits.push(r); return r; }),
  },
}));
jest.unstable_mockModule('../../src/models/House.js', () => ({ House: { find: () => chain([]) } }));
jest.unstable_mockModule('../../src/models/Estate.js', () => ({ Estate: { find: () => chain([]) } }));
jest.unstable_mockModule('../../src/models/DepositMovement.js', () => ({ DepositMovement: {} }));
jest.unstable_mockModule('../../src/models/Ledger.js', () => ({ Ledger: {} }));
jest.unstable_mockModule('../../src/models/AuditLog.js', () => ({ AuditLog: {} }));
jest.unstable_mockModule('../../src/services/audit.service.js', () => ({
  audit: async (a) => { db.audits.push(a); },
  auditRequired: async (a) => { db.audits.push(a); },
}));
jest.unstable_mockModule('../../src/services/ledger.service.js', () => ({
  ledgerService: { balanceForTenancy: async () => 0 },
}));
jest.unstable_mockModule('../../src/config/database.js', () => ({ supportsMongoTransactions: () => true }));
jest.unstable_mockModule('../../src/utils/ensureIndexes.js', () => ({ areFinancialIndexesReady: () => true }));

const { default: mongoose } = await import('mongoose');
mongoose.startSession = async () => ({
  withTransaction: async (fn) => fn(),
  endSession: () => {},
});
const { depositService } = await import('../../src/services/deposit.service.js');

const tenancy = (id, tenantId, estateId, status = 'ACTIVE', clientId = CLIENT) => ({
  _id: oid(id), clientId, tenantId, estateId, houseId: oid(id + 500), status,
});
async function code(p) { try { await p; return null; } catch (e) { return { code: e.code, status: e.status, details: e.details }; } }

beforeEach(() => {
  db.tenants = [
    { _id: T1, clientId: CLIENT, estateId: EST_A }, { _id: T2, clientId: CLIENT, estateId: EST_A },
  ];
  db.tenancies = []; db.deposits = []; db.audits = [];
});

describe('legacy tenantId resolution', () => {
  test('exactly one eligible tenancy is used', async () => {
    db.tenancies = [tenancy(31, T1, EST_A), tenancy(32, T1, EST_A, 'CLOSED')];
    const dep = await depositService.ensureRequired(CLIENT, { tenantId: T1, requiredCents: 5000 }, null);
    expect(String(dep.tenancyId)).toBe(oid(31));
  });

  test('multiple eligible tenancies in the same estate -> typed 409, nothing written', async () => {
    db.tenancies = [tenancy(31, T1, EST_A), tenancy(32, T1, EST_A)];
    const r = await code(depositService.ensureRequired(CLIENT, { tenantId: T1, requiredCents: 5000 }, null));
    expect(r).toMatchObject({ code: 'DEPOSIT_TENANCY_AMBIGUOUS', status: 409, details: { eligibleTenancyCount: 2 } });
    expect(db.deposits).toHaveLength(0);
  });

  test('tenancies in different estates are ambiguous without estate scope, resolved with it', async () => {
    db.tenancies = [tenancy(31, T1, EST_A), tenancy(32, T1, EST_B)];
    expect((await code(depositService.ensureRequired(CLIENT, { tenantId: T1, requiredCents: 1 }, null))).code)
      .toBe('DEPOSIT_TENANCY_AMBIGUOUS');
    const dep = await depositService.ensureRequired(CLIENT, { tenantId: T1, requiredCents: 1 }, null, EST_B);
    expect(String(dep.tenancyId)).toBe(oid(32));
  });

  test('no eligible tenancy -> 422, closed/void are never picked implicitly', async () => {
    db.tenancies = [tenancy(31, T1, EST_A, 'CLOSED'), tenancy(32, T1, EST_A, 'VOID')];
    expect((await code(depositService.ensureRequired(CLIENT, { tenantId: T1, requiredCents: 1 }, null))).status).toBe(422);
  });

  test('getForTenant refuses to guess between tenancies', async () => {
    db.tenancies = [tenancy(31, T1, EST_A), tenancy(32, T1, EST_A)];
    const r = await depositService.getForTenant(CLIENT, T1, null);
    expect(r).toMatchObject({ ambiguous: true, deposit: null, eligibleTenancyCount: 2 });
    expect(r.eligibleTenancies.map((x) => String(x.tenancyId))).toEqual([oid(31), oid(32)]);
  });
});

describe('explicit tenancyId validates the whole identity', () => {
  beforeEach(() => { db.tenancies = [tenancy(31, T1, EST_A), tenancy(32, T1, EST_A), tenancy(33, T2, EST_A)]; });

  test('exact tenancy among several works', async () => {
    const dep = await depositService.ensureRequired(CLIENT, { tenantId: T1, tenancyId: oid(32), requiredCents: 700 }, null);
    expect(String(dep.tenancyId)).toBe(oid(32));
  });
  test("another tenant's tenancy is NOT FOUND", async () => {
    expect((await code(depositService.ensureRequired(CLIENT, { tenantId: T1, tenancyId: oid(33), requiredCents: 1 }, null))).code).toBe('NOT_FOUND');
  });
  test("another client's tenancy is NOT FOUND", async () => {
    db.tenancies.push(tenancy(34, T1, EST_A, 'ACTIVE', OTHER_CLIENT));
    expect((await code(depositService.ensureRequired(CLIENT, { tenantId: T1, tenancyId: oid(34), requiredCents: 1 }, null))).code).toBe('NOT_FOUND');
  });
  test('wrong estateId, and out-of-scope estate filter, are NOT FOUND', async () => {
    expect((await code(depositService.ensureRequired(CLIENT, { tenantId: T1, tenancyId: oid(31), estateId: EST_B, requiredCents: 1 }, null))).code).toBe('NOT_FOUND');
    expect((await code(depositService.ensureRequired(CLIENT, { tenantId: T1, tenancyId: oid(31), requiredCents: 1 }, null, EST_B))).code).toBeTruthy();
  });
  test('missing tenancy is NOT FOUND; malformed id is 422', async () => {
    expect((await code(depositService.ensureRequired(CLIENT, { tenantId: T1, tenancyId: oid(99), requiredCents: 1 }, null))).code).toBe('NOT_FOUND');
    expect((await code(depositService.ensureRequired(CLIENT, { tenantId: T1, tenancyId: 'nope', requiredCents: 1 }, null))).status).toBe(422);
  });
  test('closed tenancy cannot receive a requirement or payment (typed 409)', async () => {
    db.tenancies.push(tenancy(35, T1, EST_A, 'CLOSED'));
    expect((await code(depositService.ensureRequired(CLIENT, { tenancyId: oid(35), requiredCents: 1 }, null))).code).toBe('TENANCY_NOT_ELIGIBLE');
    expect((await code(depositService.recordPayment(CLIENT, T1, 100, null, null, { idempotencyKey: 'k1-abcdef12', tenancyId: oid(35) }))).code).toBe('TENANCY_NOT_ELIGIBLE');
  });
  test('void tenancy is never eligible, even for deductions', async () => {
    db.tenancies.push(tenancy(36, T1, EST_A, 'VOID'));
    expect((await code(depositService.addDeduction(CLIENT, T1, { amountCents: 1, reason: 'x' }, null, null, { idempotencyKey: 'k2-abcdef12', tenancyId: oid(36) }))).code).toBe('TENANCY_NOT_ELIGIBLE');
  });
});

describe('paid deposit requirement is locked', () => {
  const seed = (paid, req = 10000) => {
    db.tenancies = [tenancy(31, T1, EST_A)];
    db.deposits = [{
      _id: oid(801), clientId: CLIENT, tenancyId: oid(31), requiredCents: req,
      paidCents: paid, heldCents: paid, refundedCents: 0, status: paid ? 'PARTIAL' : 'REQUIRED',
      save: jest.fn(async () => {}),
    }];
  };

  test('before payment the requirement can change', async () => {
    seed(0);
    const dep = await depositService.ensureRequired(CLIENT, { tenancyId: oid(31), requiredCents: 20000 }, null);
    expect(dep.requiredCents).toBe(20000);
    expect(db.audits.map((a) => a.action)).toContain('DEPOSIT_REQUIRED');
  });

  test.each([[4000, 'partial'], [10000, 'full']])('after %i paid (%s) a different value is a typed 409 and stored values stay', async (paid) => {
    seed(paid);
    const r = await code(depositService.ensureRequired(CLIENT, { tenancyId: oid(31), requiredCents: 20000 }, null));
    expect(r).toMatchObject({ code: 'DEPOSIT_REQUIREMENT_LOCKED', status: 409, details: { requiredCents: 10000, requestedCents: 20000, paidCents: paid } });
    expect(db.deposits[0].requiredCents).toBe(10000);
    expect(db.deposits[0].save).not.toHaveBeenCalled();
    expect(db.audits.map((a) => a.action)).toEqual(['DEPOSIT_REQUIREMENT_CHANGE_REFUSED']);
  });

  test('after refund/deduction (held reduced, paid retained) it is still locked', async () => {
    seed(10000);
    db.deposits[0].heldCents = 3000; db.deposits[0].refundedCents = 5000;
    expect((await code(depositService.ensureRequired(CLIENT, { tenancyId: oid(31), requiredCents: 1 }, null))).code).toBe('DEPOSIT_REQUIREMENT_LOCKED');
  });

  test('re-sending the SAME value is a silent no-op: no write, no audit', async () => {
    seed(4000);
    const dep = await depositService.ensureRequired(CLIENT, { tenancyId: oid(31), requiredCents: 10000 }, null);
    expect(dep.requiredCents).toBe(10000);
    expect(db.deposits[0].save).not.toHaveBeenCalled();
    expect(db.audits).toHaveLength(0);
  });
});
