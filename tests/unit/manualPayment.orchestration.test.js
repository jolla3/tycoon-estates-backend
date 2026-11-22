import '../setup.js';
import { jest } from '@jest/globals';
import mongoose from 'mongoose';

const calls = [];
const clientId = 'client-1', estateId = 'estate-1', houseId = 'house-1';
const tenantId = 'tenant-1', tenancyId = 'tenancy-1';
const house = { _id: houseId, estateId, houseNumber: '78' };
const tenant = { _id: tenantId, estateId, name: 'Alice', phone: '+254700000001' };
let receiptStore = null, settlementFailure = null, session;
const query = (value) => {
  const q = { session: jest.fn(() => q), lean: jest.fn(() => q), select: jest.fn(() => q),
    then: (resolve, reject) => Promise.resolve(value).then(resolve, reject) };
  return q;
};
const House = { findOne: jest.fn(() => query(house)) };
const Tenant = { findOne: jest.fn(() => query(tenant)) };
const Payment = { findOne: jest.fn(() => query(null)), find: jest.fn(() => query([])) };
const PaymentAllocation = { find: jest.fn(() => query([])) };
const TenantCreditMovement = { find: jest.fn(() => query([])) };
const ManualReceipt = {
  findOne: jest.fn(() => query(receiptStore)),
  create: jest.fn(async ([input], options) => {
    calls.push(['receipt:create', options?.session]);
    const doc = { ...input, _id: 'receipt-1',
      save: jest.fn(async (opts) => calls.push(['receipt:save', opts?.session])) };
    receiptStore = doc;
    return [doc];
  }),
};
const audit = jest.fn(async () => calls.push(['audit']));
const assertManualReceiptIndexesAligned = jest.fn(async () => {});
const resolveExplicitForManualPayment = jest.fn(async (_client, h, ids) => {
  calls.push(['resolve', h, ids]);
  return { tenancy: { _id: ids.tenancyId, tenantId: ids.tenantId, estateId }, tenant };
});
const settleTenantAccount = jest.fn(async ({ session: tx, tenantId: targetTenantId, estateId: targetEstateId }) => {
  calls.push(['settle', tx, targetTenantId, targetEstateId]);
  if (settlementFailure) throw settlementFailure;
  return { plan: { creditAppliedCents: 0, receiptAppliedCents: 125000, newCreditCents: 0 },
    receiptPayments: [{ _id: 'payment-1', amountCents: 125000 }], creditPayments: [], movements: [],
    allocations: [{ paymentId: 'payment-1', amountCents: 125000 }] };
});
const tenantAccountSnapshot = jest.fn(async () => ({ netCents: 0, creditCents: 0, outstandingCents: 0 }));
const mockTransaction = jest.fn(async (callback) => {
  calls.push(['transaction:start']);
  try { await callback(); calls.push(['transaction:commit']); }
  catch (error) { calls.push(['transaction:abort']); throw error; }
});
const mockEndSession = jest.fn(async () => calls.push(['session:end']));
jest.unstable_mockModule('../../src/models/House.js', () => ({ House }));
jest.unstable_mockModule('../../src/models/Tenant.js', () => ({ Tenant }));
jest.unstable_mockModule('../../src/models/Payment.js', () => ({ Payment }));
jest.unstable_mockModule('../../src/models/PaymentAllocation.js', () => ({ PaymentAllocation }));
jest.unstable_mockModule('../../src/models/ManualReceipt.js', () => ({ ManualReceipt }));
jest.unstable_mockModule('../../src/models/TenantCreditMovement.js', () => ({ TenantCreditMovement }));
jest.unstable_mockModule('../../src/services/audit.service.js', () => ({ audit, auditRequired: jest.fn(), listAuditLogs: jest.fn() }));
jest.unstable_mockModule('../../src/services/tenancy.service.js', () => ({ tenancyService: { resolveExplicitForManualPayment } }));
jest.unstable_mockModule('../../src/services/tenantCredit.service.js', () => ({ settleTenantAccount, tenantAccountSnapshot, creditBalanceCents: jest.fn() }));
jest.unstable_mockModule('../../src/utils/manualReceiptIndexReadiness.js', () => ({ assertManualReceiptIndexesAligned }));
jest.unstable_mockModule('../../src/config/database.js', () => ({
  supportsMongoTransactions: () => true, connectDatabase: jest.fn(), disconnectDatabase: jest.fn(), isDatabaseReady: () => true,
}));
const { paymentService } = await import('../../src/services/payment.service.js');

beforeEach(() => {
  calls.length = 0; receiptStore = null; settlementFailure = null;
  House.findOne.mockImplementation(() => query(house));
  Tenant.findOne.mockImplementation(() => query(tenant));
  ManualReceipt.findOne.mockImplementation(() => query(receiptStore));
  ManualReceipt.create.mockClear();
  Payment.findOne.mockImplementation(() => query(null));
  Payment.find.mockImplementation(() => query([]));
  PaymentAllocation.find.mockImplementation(() => query([]));
  TenantCreditMovement.find.mockImplementation(() => query([]));
  audit.mockClear(); resolveExplicitForManualPayment.mockClear(); settleTenantAccount.mockClear();
  tenantAccountSnapshot.mockClear(); assertManualReceiptIndexesAligned.mockClear();
  mockTransaction.mockClear(); mockEndSession.mockClear();
  session = { withTransaction: mockTransaction, endSession: mockEndSession };
  jest.spyOn(mongoose, 'startSession').mockResolvedValue(session);
});
afterEach(() => jest.restoreAllMocks());
const body = (overrides = {}) => ({ houseId, tenantId, tenancyId, amountCents: 125000,
  paymentDate: '2026-08-10', tenderMethod: 'CASH', idempotencyKey: 'manual-attempt-0001', ...overrides });

describe('paymentService.recordManual orchestration', () => {
  test('passes explicit tenant and tenancy through settlement with one MongoDB session', async () => {
    const result = await paymentService.recordManual(clientId, body());
    expect(result.receipt).toMatchObject({ _id: 'receipt-1', tenantId, occupancyTenancyId: tenancyId });
    expect(resolveExplicitForManualPayment).toHaveBeenCalledWith(clientId, house, { tenantId, tenancyId }, expect.objectContaining({ dateStr: '2026-08-10' }), { session });
    expect(settleTenantAccount).toHaveBeenCalledWith(expect.objectContaining({ clientId, estateId, tenantId, session }));
    expect(ManualReceipt.create).toHaveBeenCalledWith([expect.objectContaining({ clientId, estateId, tenantId, houseId, occupancyTenancyId: tenancyId })], { session });
    expect(calls).toContainEqual(['receipt:save', session]);
    expect(mockTransaction).toHaveBeenCalledTimes(1);
    expect(mockEndSession).toHaveBeenCalledTimes(1);
  });
  test('idempotent retry reuses the canonical receipt without another settlement', async () => {
    const first = await paymentService.recordManual(clientId, body());
    const createCount = ManualReceipt.create.mock.calls.length;
    const settlementCount = settleTenantAccount.mock.calls.length;
    const second = await paymentService.recordManual(clientId, body());
    expect(second.reused).toBe(true);
    expect(second.receipt._id).toBe(first.receipt._id);
    expect(ManualReceipt.create).toHaveBeenCalledTimes(createCount);
    expect(settleTenantAccount).toHaveBeenCalledTimes(settlementCount);
  });
  test('audit logging occurs only after transaction commit and session completion', async () => {
    await paymentService.recordManual(clientId, body());
    const commit = calls.findIndex(([name]) => name === 'transaction:commit');
    const end = calls.findIndex(([name]) => name === 'session:end');
    const log = calls.findIndex(([name]) => name === 'audit');
    expect(commit).toBeGreaterThanOrEqual(0);
    expect(end).toBeGreaterThan(commit);
    expect(log).toBeGreaterThan(end);
    expect(audit).toHaveBeenCalledTimes(1);
  });
  test('failed settlement aborts and never audits successful payment', async () => {
    settlementFailure = new Error('settlement failed');
    await expect(paymentService.recordManual(clientId, body())).rejects.toThrow('settlement failed');
    expect(calls).toContainEqual(['transaction:abort']);
    expect(mockEndSession).toHaveBeenCalledTimes(1);
    expect(audit).not.toHaveBeenCalled();
  });
});
