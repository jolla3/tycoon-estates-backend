/**
 * Explicit-tenant manual receipts + receipt visibility + credit accounting (DB-backed).
 * Requires a disposable replica-set MONGODB_URI, TYCOON_ALLOW_DESTRUCTIVE_TEST_DB=1 and a
 * tycoon_test_* database; skipped otherwise. NOTE: authored where no MongoDB was available,
 * so these have NOT been executed by the author.
 */
import '../setup.js';
import { jest } from '@jest/globals';
import { describeWithMongo, connectTestDb, clearTestDb, disconnectTestDb } from '../helpers/db.js';
import { prepareG3TestIndexes } from '../helpers/g3Indexes.js';
import { Client } from '../../src/models/Client.js';
import { Estate } from '../../src/models/Estate.js';
import { House } from '../../src/models/House.js';
import { Tenant } from '../../src/models/Tenant.js';
import { Tenancy } from '../../src/models/Tenancy.js';
import { RentCharge } from '../../src/models/RentCharge.js';
import { Payment } from '../../src/models/Payment.js';
import { ManualReceipt } from '../../src/models/ManualReceipt.js';
import { TenantCreditMovement } from '../../src/models/TenantCreditMovement.js';
import { Ledger } from '../../src/models/Ledger.js';
import { paymentService } from '../../src/services/payment.service.js';
import { tenantService } from '../../src/services/tenant.service.js';
import { tenantAccountSnapshot } from '../../src/services/tenantCredit.service.js';
import { dateUtil } from '../../src/utils/date.js';

describeWithMongo('explicit manual receipts', () => {
  let client, otherClient, estate, otherEstate, house, house2, otherEstateHouse;
  let alice, bob, carol, tenA, tenB, tenC2;
  beforeAll(connectTestDb);
  afterAll(disconnectTestDb);
  afterEach(() => jest.restoreAllMocks());

  const mkCharge = (tenancy, period, cents, chargeEstate = estate) => RentCharge.create({
    clientId: client._id, estateId: chargeEstate._id, houseId: tenancy.houseId, tenantId: tenancy.tenantId,
    tenancyId: tenancy._id, period, chargeType: 'RENT', description: 'Rent',
    amountDueCents: cents, amountPaidCents: 0, balanceCents: cents, status: 'UNPAID',
    dueDate: new Date(`${period}-05T12:00:00+03:00`),
  });
  let n = 0;
  const key = () => `idem-key-${++n}-${Date.now()}`;
  const rec = (o) => paymentService.recordManual(client._id, {
    paymentDate: '2026-08-10', tenderMethod: 'CASH', idempotencyKey: key(), ...o,
  });
  const ids = (tenant, tenancy) => ({ tenantId: String(tenant._id), tenancyId: String(tenancy._id), houseId: String(tenancy.houseId) });
  const mkLedger = (tenancy, amountCents, entryType) => Ledger.create({
    clientId: client._id, estateId: tenancy.estateId, houseId: tenancy.houseId,
    tenantId: tenancy.tenantId, tenancyId: tenancy._id, accountCategory: 'RENT',
    entryType, amountCents, runningBalanceCents: amountCents,
    description: 'Tenant account regression fixture',
  });

  beforeEach(async () => {
    await clearTestDb();
    await prepareG3TestIndexes();
    client = await Client.create({ name: 'C' });
    otherClient = await Client.create({ name: 'Other' });
    estate = await Estate.create({ clientId: client._id, name: 'E', isActive: true });
    otherEstate = await Estate.create({ clientId: client._id, name: 'E2', isActive: true });
    const mkHouse = (e, no) => House.create({
      clientId: client._id, estateId: e._id, houseNumber: no, monthlyRent: 10000,
      billingSource: 'MONTHLY_RENT', status: 'occupied', isActive: true, dueDay: 5,
    });
    house = await mkHouse(estate, '78');
    house2 = await mkHouse(estate, '79');
    otherEstateHouse = await mkHouse(otherEstate, 'X1');
    const mkT = (e, h, name) => Tenant.create({ clientId: client._id, estateId: e._id, houseId: h._id, name, phone: '+254711000001' });
    alice = await mkT(estate, house, 'Alice Former');
    bob = await mkT(estate, house, 'Bob Current');
    carol = await mkT(estate, house2, 'Carol');
    tenA = await Tenancy.create({ clientId: client._id, estateId: estate._id, houseId: house._id, tenantId: alice._id,
      startAt: new Date('2026-01-01T00:00:00+03:00'), endAt: new Date('2026-07-01T00:00:00+03:00'), status: 'CLOSED' });
    tenB = await Tenancy.create({ clientId: client._id, estateId: estate._id, houseId: house._id, tenantId: bob._id,
      startAt: new Date('2026-07-01T00:00:00+03:00'), endAt: new Date('2026-10-01T00:00:00+03:00'), status: 'CLOSED' });
    tenC2 = await Tenancy.create({ clientId: client._id, estateId: estate._id, houseId: house2._id, tenantId: carol._id,
      startAt: new Date('2026-01-01T00:00:00+03:00'), endAt: null, status: 'ACTIVE' });
    house.tenantId = bob._id; await house.save();
    house2.tenantId = carol._id; await house2.save();
  });

  test('backdated receipt belongs to the FORMER tenant, never the current occupant', async () => {
    const r = await rec({ ...ids(alice, tenA), amountCents: 100000, paymentDate: '2026-03-10' });
    expect(String(r.receipt.tenantId)).toBe(String(alice._id));
    expect(String(r.receipt.occupancyTenancyId)).toBe(String(tenA._id));
    expect(await ManualReceipt.countDocuments({ tenantId: bob._id })).toBe(0);
  });

  test.each([
    ['tenancy of another tenant', () => ({ tenantId: bob._id, tenancyId: tenA._id, houseId: house._id }), '2026-03-10'],
    ['tenancy that did not cover the date', () => ({ tenantId: alice._id, tenancyId: tenA._id, houseId: house._id }), '2026-09-01'],
    ['house of another estate', () => ({ tenantId: alice._id, tenancyId: tenA._id, houseId: otherEstateHouse._id }), '2026-03-10'],
    ['tenancy on a different house', () => ({ tenantId: alice._id, tenancyId: tenC2._id, houseId: house._id }), '2026-03-10'],
    ['invalid date', () => ({ tenantId: alice._id, tenancyId: tenA._id, houseId: house._id }), '2026-02-31'],
  ])('rejects %s and writes nothing', async (_n, mk, date) => {
    const body = Object.fromEntries(Object.entries(mk()).map(([k, v]) => [k, String(v)]));
    await expect(rec({ ...body, amountCents: 5000, paymentDate: date })).rejects.toMatchObject({ code: 'INVALID_REQUEST' });
    expect(await ManualReceipt.countDocuments({})).toBe(0);
    expect(await TenantCreditMovement.countDocuments({})).toBe(0);
  });

  test('other client cannot use these ids (estate/client scoping)', async () => {
    await expect(paymentService.recordManual(otherClient._id, {
      ...ids(bob, tenB), amountCents: 5000, paymentDate: '2026-08-10', tenderMethod: 'CASH', idempotencyKey: key(),
    })).rejects.toBeDefined();
    expect(await ManualReceipt.countDocuments({})).toBe(0);
  });

  test('missing tenantId/tenancyId is rejected (no silent assignment)', async () => {
    await expect(rec({ houseId: String(house._id), amountCents: 5000 })).rejects.toMatchObject({ code: 'INVALID_REQUEST' });
  });

  test('same key retried returns the original; same key with another tenant conflicts', async () => {
    const k = key();
    const a = await rec({ ...ids(bob, tenB), amountCents: 7000, idempotencyKey: k });
    const b = await rec({ ...ids(bob, tenB), amountCents: 7000, idempotencyKey: k });
    expect(b.reused).toBe(true);
    expect(String(b.receipt._id)).toBe(String(a.receipt._id));
    await expect(rec({ ...ids(carol, tenC2), amountCents: 7000, idempotencyKey: k })).rejects.toMatchObject({ code: 'CONFLICT' });
    expect(await ManualReceipt.countDocuments({})).toBe(1);
  });

  test('different keys, same reference: second is rejected', async () => {
    await rec({ ...ids(bob, tenB), amountCents: 7000, paymentReference: 'REF-1' });
    await expect(rec({ ...ids(bob, tenB), amountCents: 7000, paymentReference: 'REF-1' })).rejects.toMatchObject({ code: 'CONFLICT' });
  });

  test('pure-surplus receipt: visible once with NO child Payment; four figures stay distinct', async () => {
    await rec({ ...ids(bob, tenB), amountCents: 1000300 });
    expect(await Payment.countDocuments({ tenantId: bob._id })).toBe(0);
    const t = await tenantService.get(client._id, bob._id);
    expect(t.paymentHistory).toHaveLength(1);
    expect(t.paymentHistory[0]).toMatchObject({ kind: 'manual_receipt', grossCents: 1000300, appliedToRentCents: 0, newCreditCents: 1000300 });
    expect(t.account).toMatchObject({ receivedCents: 1000300, appliedToRentCents: 0, creditCents: 1000300, outstandingCents: 0, billedCents: 0 });
  });

  test('new tenancy manual receipt immediately creates and pays its first full due-day cycle', async () => {
    jest.spyOn(dateUtil, 'currentPeriod').mockReturnValue('2026-11');
    const liveHouse = await House.create({
      clientId: client._id, estateId: estate._id, houseNumber: 'NEW-1', monthlyRent: 9000,
      billingSource: 'MONTHLY_RENT', status: 'occupied', isActive: true, dueDay: 17,
    });
    const newTenant = await Tenant.create({
      clientId: client._id, estateId: estate._id, houseId: liveHouse._id,
      name: 'New Tenant', phone: '+254711000009',
    });
    liveHouse.tenantId = newTenant._id; await liveHouse.save();
    const newTenancy = await Tenancy.create({
      clientId: client._id, estateId: estate._id, houseId: liveHouse._id, tenantId: newTenant._id,
      startAt: new Date('2026-11-21T00:00:00+03:00'), endAt: null, status: 'ACTIVE',
    });

    const result = await rec({
      ...ids(newTenant, newTenancy), houseId: String(liveHouse._id),
      amountCents: 900000, paymentDate: '2026-11-25',
    });

    expect(result.receipt).toMatchObject({ receiptAppliedCents: 900000, newCreditCents: 0 });
    const charge = await RentCharge.findOne({ tenancyId: newTenancy._id, period: '2026-12', chargeType: 'RENT' });
    expect(charge).toMatchObject({ amountDueCents: 900000, amountPaidCents: 900000, balanceCents: 0, status: 'PAID' });
    const tenantView = await tenantService.get(client._id, newTenant._id);
    expect(tenantView.account).toMatchObject({
      receivedCents: 900000, billedCents: 900000, appliedToRentCents: 900000,
      creditCents: 0, outstandingCents: 0,
    });
    expect(tenantView.paymentHistory[0]).toMatchObject({ kind: 'manual_receipt', grossCents: 900000, appliedToRentCents: 900000, newCreditCents: 0 });
    expect(tenantView.payments).toHaveLength(1);
    expect(tenantView.billingHistory).toHaveLength(1);
    expect(tenantView.billingHistory[0]).toMatchObject({ period: '2026-12', amountDueCents: 900000, amountPaidCents: 900000, balanceCents: 0 });
    expect(await RentCharge.countDocuments({ tenancyId: newTenancy._id, period: '2027-01' })).toBe(0);
  });

  test('known case: receipts 10,003 + 80,000 with no charges => received 90,003, credit 90,003, applied 0, outstanding 0', async () => {
    await rec({ ...ids(bob, tenB), amountCents: 1000300 });
    await rec({ ...ids(bob, tenB), amountCents: 8000000 });
    const t = await tenantService.get(client._id, bob._id);
    expect(t.paymentHistory).toHaveLength(2);
    expect(t.account).toMatchObject({ receivedCents: 9000300, creditCents: 9000300, appliedToRentCents: 0, outstandingCents: 0 });
  });

  test('partial, full and surplus; invariant gross = applied + new credit; credit used first next time', async () => {
    await mkCharge(tenB, '2026-08', 1000000);
    const partial = await rec({ ...ids(bob, tenB), amountCents: 400000 });
    expect(partial.receipt).toMatchObject({ receiptAppliedCents: 400000, newCreditCents: 0, creditAppliedCents: 0 });
    const surplus = await rec({ ...ids(bob, tenB), amountCents: 900000 });
    expect(surplus.receipt.receiptAppliedCents + surplus.receipt.newCreditCents).toBe(900000);
    expect(surplus.receipt).toMatchObject({ receiptAppliedCents: 600000, newCreditCents: 300000 });
    await mkCharge(tenB, '2026-09', 500000);
    const next = await rec({ ...ids(bob, tenB), amountCents: 100000, paymentDate: '2026-09-10' });
    expect(next.receipt.creditAppliedCents).toBe(300000); // credit first, reported separately
    expect(next.receipt.receiptAppliedCents + next.receipt.newCreditCents).toBe(100000);
    const snap = await tenantAccountSnapshot({ clientId: client._id, estateId: estate._id, tenantId: bob._id });
    expect(snap.outstandingCents).toBe(100000);
    const t = await tenantService.get(client._id, bob._id);
    expect(t.account.receivedCents).toBe(1400000); // gross receipts only; credit use is not received
    expect(t.paymentHistory).toHaveLength(3);
  });

  test('selected house does not restrict settlement: receipt on house 78 pays older obligation on another tenancy', async () => {
    const other = await Tenancy.create({ clientId: client._id, estateId: estate._id, houseId: house2._id, tenantId: bob._id,
      startAt: new Date('2026-02-01T00:00:00+03:00'), endAt: new Date('2026-06-01T00:00:00+03:00'), status: 'CLOSED' });
    await mkCharge(other, '2026-03', 200000);
    const r = await rec({ ...ids(bob, tenB), amountCents: 250000 });
    expect(r.receipt).toMatchObject({ receiptAppliedCents: 200000, newCreditCents: 50000 });
    expect(String(r.receipt.houseId)).toBe(String(house._id));
  });

  test('another occupant\'s charges on the same house never appear in a tenant account', async () => {
    await mkCharge(tenA, '2026-02', 700000);
    const t = await tenantService.get(client._id, bob._id);
    expect(t.account.billedCents).toBe(0);
    expect(t.billingHistory).toHaveLength(0);
  });

  test('former tenant arrears come from their own closed tenancy, not the house current occupant', async () => {
    await mkCharge(tenA, '2026-02', 700000);
    await mkCharge(tenB, '2026-08', 1100000);
    await mkLedger(tenA, -300000, 'CHARGE');
    await mkLedger(tenB, -1000000, 'CHARGE');
    const former = await tenantService.get(client._id, alice._id);
    expect(former.financials.knownArrearsCents).toBe(300000);
    expect(former.financials.outstandingCents).toBe(700000);
    expect(former.account.outstandingCents).toBe(700000);
    expect(former.financials.verifiedFullObligation).toBe(false);
  });

  test('multiple same-estate tenancies are included without netting credit against arrears', async () => {
    const aliceSecond = await Tenancy.create({
      clientId: client._id, estateId: estate._id, houseId: house2._id, tenantId: alice._id,
      startAt: new Date('2025-01-01T00:00:00+03:00'),
      endAt: new Date('2025-12-01T00:00:00+03:00'), status: 'CLOSED',
    });
    await mkCharge(tenA, '2026-02', 500000);
    await mkCharge(aliceSecond, '2025-11', 400000);
    await mkLedger(tenA, -300000, 'CHARGE');
    await mkLedger(aliceSecond, 600000, 'PAYMENT');
    const t = await tenantService.get(client._id, alice._id);
    expect(t.account.billedCents).toBe(900000);
    expect(t.account.outstandingCents).toBe(900000);
    expect(t.financials.knownArrearsCents).toBe(300000);
    expect(t.financials.historicalCoverage).toBe('UNVERIFIED');
    expect(t.financials.verifiedFullObligation).toBe(false);
  });

  test('historical RentCharges from another estate are excluded from current-estate projections', async () => {
    await mkCharge(tenA, '2026-02', 500000);
    const alicePriorEstateTenancy = await Tenancy.create({
      clientId: client._id, estateId: otherEstate._id, houseId: otherEstateHouse._id,
      tenantId: alice._id, startAt: new Date('2025-01-01T00:00:00+03:00'),
      endAt: new Date('2025-12-01T00:00:00+03:00'), status: 'CLOSED',
    });
    await mkCharge(alicePriorEstateTenancy, '2025-12', 900000, otherEstate);
    const t = await tenantService.get(client._id, alice._id);
    expect(t.account.billedCents).toBe(500000);
    expect(t.account.outstandingCents).toBe(500000);
    expect(t.financials.billedCents).toBe(500000);
    expect(t.monthly).toHaveLength(1);
    expect(t.billingHistory).toHaveLength(1);
    expect(t.billingHistory[0].period).toBe('2026-02');
  });

  test('known arrears are unavailable when there is no RENT ledger evidence', async () => {
    const t = await tenantService.get(client._id, alice._id);
    expect(t.financials.knownArrearsCents).toBeNull();
    expect(t.financials.historicalCoverage).toBe('UNVERIFIED');
    expect(t.financials.verifiedFullObligation).toBe(false);
    expect(t.financials.balanceSource).toBe('unavailable');
  });

  test('a receipt split across tenancy allocations appears once in canonical tenant history', async () => {
    const bobFormer = await Tenancy.create({
      clientId: client._id, estateId: estate._id, houseId: house2._id, tenantId: bob._id,
      startAt: new Date('2026-01-01T00:00:00+03:00'),
      endAt: new Date('2026-06-01T00:00:00+03:00'), status: 'CLOSED',
    });
    await mkCharge(bobFormer, '2026-03', 300000);
    await mkCharge(tenB, '2026-08', 400000);
    const result = await rec({ ...ids(bob, tenB), amountCents: 700000 });
    expect(result.payments).toHaveLength(2);
    expect(await Payment.countDocuments({ manualReceiptId: result.receipt._id })).toBe(2);
    const t = await tenantService.get(client._id, bob._id);
    expect(t.paymentHistory.filter((row) => row.kind === 'manual_receipt')).toHaveLength(1);
    expect(t.paymentHistory[0]).toMatchObject({ kind: 'manual_receipt', grossCents: 700000 });
    const list = await paymentService.list(client._id, null, { page: 1, limit: 20 });
    expect(list.items.filter((row) => String(row.manualReceiptId) === String(result.receipt._id))).toHaveLength(1);
  });

  test('settlement failure aborts without persisting a partial receipt or credit movement', async () => {
    jest.spyOn(TenantCreditMovement, 'create').mockImplementationOnce(async () => {
      throw new Error('forced settlement failure');
    });
    await expect(rec({ ...ids(alice, tenA), amountCents: 500000 })).rejects.toThrow('forced settlement failure');
    expect(await ManualReceipt.countDocuments({})).toBe(0);
    expect(await TenantCreditMovement.countDocuments({})).toBe(0);
    expect(await Payment.countDocuments({})).toBe(0);
  });

  test('concurrent receipts cannot spend the same credit twice', async () => {
    await rec({ ...ids(bob, tenB), amountCents: 500000 });
    await mkCharge(tenB, '2026-08', 500000);
    await Promise.allSettled([
      rec({ ...ids(bob, tenB), amountCents: 1000 }),
      rec({ ...ids(bob, tenB), amountCents: 2000 }),
    ]);
    const used = await TenantCreditMovement.aggregate([
      { $match: { tenantId: bob._id, movementType: 'CREDIT_APPLIED' } }, { $group: { _id: null, t: { $sum: '$amountCents' } } },
    ]);
    expect(-(used[0]?.t || 0)).toBeLessThanOrEqual(500000);
    const snap = await tenantAccountSnapshot({ clientId: client._id, estateId: estate._id, tenantId: bob._id });
    expect(snap.creditCents).toBeGreaterThanOrEqual(0);
    expect(snap.outstandingCents).toBeGreaterThanOrEqual(0);
  });

  test('estate payments list shows tenant name and house number, one row per receipt, missing relations degrade', async () => {
    await rec({ ...ids(bob, tenB), amountCents: 5000, paymentReference: 'L-1' });
    const gone = await rec({ ...ids(carol, tenC2), amountCents: 6000 });
    await Tenant.deleteOne({ _id: carol._id });
    const list = await paymentService.list(client._id, null, { page: 1, limit: 20 });
    expect(list.items).toHaveLength(2);
    const bobRow = list.items.find((i) => i.paymentReference === 'L-1');
    expect(bobRow).toMatchObject({ tenantName: 'Bob Current', houseNumber: '78', amountCents: 5000 });
    const carolRow = list.items.find((i) => String(i.manualReceiptId) === String(gone.receipt._id));
    expect(carolRow.tenantName).toBeNull();
    expect(carolRow.houseNumber).toBe('79');
  });

  test('tenant-context lists the tenant tenancies and flags those covering the date', async () => {
    const c = await paymentService.tenantContext(client._id, null, { tenantId: String(alice._id), paymentDate: '2026-03-10' });
    expect(c.tenancies).toHaveLength(1);
    expect(c.tenancies[0]).toMatchObject({ houseNumber: '78', status: 'CLOSED', coversPaymentDate: true });
    const later = await paymentService.tenantContext(client._id, null, { tenantId: String(alice._id), paymentDate: '2026-09-01' });
    expect(later.tenancies[0].coversPaymentDate).toBe(false);
    await expect(paymentService.tenantContext(otherClient._id, null, { tenantId: String(alice._id) })).rejects.toMatchObject({ code: 'TENANT_NOT_FOUND' });
  });
});
