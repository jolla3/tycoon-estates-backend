/**
 * Behavioural deposit idempotency — requires MONGODB_URI to a disposable replica set.
 */
import mongoose from 'mongoose';
import { hasMongo, connectTestDb, clearTestDb, disconnectTestDb } from '../helpers/db.js';
import { prepareG3TestIndexes } from '../helpers/g3Indexes.js';
import { depositService } from '../../src/services/deposit.service.js';
import { Deposit } from '../../src/models/Deposit.js';
import { DepositMovement } from '../../src/models/DepositMovement.js';
import { Ledger } from '../../src/models/Ledger.js';
import { Tenancy } from '../../src/models/Tenancy.js';
import { Tenant } from '../../src/models/Tenant.js';
import { House } from '../../src/models/House.js';
import { Estate } from '../../src/models/Estate.js';
import { Client } from '../../src/models/Client.js';
import { AuditLog } from '../../src/models/AuditLog.js';

import { supportsMongoTransactions } from '../../src/config/database.js';

const describeMongo = hasMongo ? describe : describe.skip;

async function seed() {
  const suffix = `${Date.now()}-${Math.random().toString(16).slice(2, 8)}`;
  const client = await Client.create({ name: 'C', slug: `c-${suffix}`, status: 'ACTIVE' });
  const estate = await Estate.create({ clientId: client._id, name: 'E', code: `E${suffix.slice(0, 4)}` });
  const house = await House.create({
    clientId: client._id, estateId: estate._id, houseNumber: 'H1',
    monthlyRent: 0, billingSource: 'UNCONFIGURED', status: 'occupied',
  });
  const tenant = await Tenant.create({
    clientId: client._id, estateId: estate._id, houseId: house._id,
    name: 'T', phone: `+2547${String(Date.now()).slice(-8)}`, status: 'active',
  });
  const tenancy = await Tenancy.create({
    clientId: client._id, estateId: estate._id, houseId: house._id, tenantId: tenant._id,
    startAt: new Date('2026-01-01'), status: 'ACTIVE',
  });
  // second tenancy for transfer target
  const house2 = await House.create({
    clientId: client._id, estateId: estate._id, houseNumber: 'H2',
    monthlyRent: 0, billingSource: 'UNCONFIGURED', status: 'occupied',
  });
  const tenant2 = await Tenant.create({
    clientId: client._id, estateId: estate._id, houseId: house2._id,
    name: 'T2', phone: `+2547${String(Date.now() + 1).slice(-8)}`, status: 'active',
  });
  const tenancy2 = await Tenancy.create({
    clientId: client._id, estateId: estate._id, houseId: house2._id, tenantId: tenant2._id,
    startAt: new Date('2026-01-01'), status: 'ACTIVE',
  });
  const actor = { _id: new mongoose.Types.ObjectId() };
  return {
    clientId: client._id,
    estateId: estate._id,
    tenantId: tenant._id,
    tenancyId: tenancy._id,
    tenancy2Id: tenancy2._id,
    actor,
  };
}

describeMongo('deposit idempotency behaviour', () => {
  beforeAll(async () => {
    await connectTestDb();
    if (supportsMongoTransactions() !== true) {
      throw new Error('Deposit integration tests require verified MongoDB transaction support');
    }
    await clearTestDb();
    await prepareG3TestIndexes();
    await Promise.all([Deposit.createIndexes(), DepositMovement.createIndexes()]);
  });
  afterEach(clearTestDb);
  afterAll(disconnectTestDb);

  test('receipt replay does not double paid/held', async () => {
    const ctx = await seed();
    await depositService.ensureRequired(ctx.clientId, { tenancyId: ctx.tenancyId, requiredCents: 5000 }, ctx.actor);
    expect(await AuditLog.countDocuments({ clientId: ctx.clientId, action: 'DEPOSIT_REQUIRED' })).toBe(1);
    const key = `recv-${ctx.tenancyId}`;
    await depositService.recordPayment(ctx.clientId, ctx.tenantId, 5000, ctx.actor, null, {
      idempotencyKey: key, tenancyId: ctx.tenancyId,
    });
    const mid = await Deposit.findOne({ tenancyId: ctx.tenancyId }).lean();
    await depositService.recordPayment(ctx.clientId, ctx.tenantId, 5000, ctx.actor, null, {
      idempotencyKey: key, tenancyId: ctx.tenancyId,
    });
    const after = await Deposit.findOne({ tenancyId: ctx.tenancyId }).lean();
    expect(after.paidCents).toBe(mid.paidCents);
    expect(after.heldCents).toBe(mid.heldCents);
    expect(await DepositMovement.countDocuments({ depositId: after._id, type: 'RECEIVED' })).toBe(1);
    expect(await Ledger.countDocuments({
      tenancyId: ctx.tenancyId, accountCategory: 'DEPOSIT', entryType: 'DEPOSIT_RECEIVED',
    })).toBe(1);
    expect(await AuditLog.countDocuments({ clientId: ctx.clientId, action: 'DEPOSIT_RECEIVED' })).toBe(1);
  });

  test('deduction replay does not reduce held twice', async () => {
    const ctx = await seed();
    await depositService.ensureRequired(ctx.clientId, { tenancyId: ctx.tenancyId, requiredCents: 10000 }, ctx.actor);
    await depositService.recordPayment(ctx.clientId, ctx.tenantId, 10000, ctx.actor, null, {
      idempotencyKey: `r-${ctx.tenancyId}`, tenancyId: ctx.tenancyId,
    });
    const key = `d-${ctx.tenancyId}`;
    await depositService.addDeduction(ctx.clientId, ctx.tenantId, { amountCents: 1000, reason: 'paint' }, ctx.actor, null, {
      idempotencyKey: key, tenancyId: ctx.tenancyId,
    });
    const mid = await Deposit.findOne({ tenancyId: ctx.tenancyId }).lean();
    await depositService.addDeduction(ctx.clientId, ctx.tenantId, { amountCents: 1000, reason: 'paint' }, ctx.actor, null, {
      idempotencyKey: key, tenancyId: ctx.tenancyId,
    });
    const after = await Deposit.findOne({ tenancyId: ctx.tenancyId }).lean();
    expect(after.heldCents).toBe(mid.heldCents);
    expect(await DepositMovement.countDocuments({ depositId: after._id, type: 'DEDUCTION' })).toBe(1);
    expect(await AuditLog.countDocuments({ clientId: ctx.clientId, action: 'DEPOSIT_DEDUCTION' })).toBe(1);
  });

  test('refund replay does not change held/refunded twice', async () => {
    const ctx = await seed();
    await depositService.ensureRequired(ctx.clientId, { tenancyId: ctx.tenancyId, requiredCents: 10000 }, ctx.actor);
    await depositService.recordPayment(ctx.clientId, ctx.tenantId, 10000, ctx.actor, null, {
      idempotencyKey: `rr-${ctx.tenancyId}`, tenancyId: ctx.tenancyId,
    });
    const key = `ref-${ctx.tenancyId}`;
    await depositService.refund(ctx.clientId, ctx.tenantId, 2000, ctx.actor, null, {
      idempotencyKey: key, tenancyId: ctx.tenancyId,
    });
    const mid = await Deposit.findOne({ tenancyId: ctx.tenancyId }).lean();
    await depositService.refund(ctx.clientId, ctx.tenantId, 2000, ctx.actor, null, {
      idempotencyKey: key, tenancyId: ctx.tenancyId,
    });
    const after = await Deposit.findOne({ tenancyId: ctx.tenancyId }).lean();
    expect(after.heldCents).toBe(mid.heldCents);
    expect(after.refundedCents).toBe(mid.refundedCents);
    expect(await DepositMovement.countDocuments({ depositId: after._id, type: 'REFUND' })).toBe(1);
    expect(await AuditLog.countDocuments({ clientId: ctx.clientId, action: 'DEPOSIT_REFUND' })).toBe(1);
  });

  test('transfer creates linked pair and replay is stable', async () => {
    const ctx = await seed();
    await depositService.ensureRequired(ctx.clientId, { tenancyId: ctx.tenancyId, requiredCents: 10000 }, ctx.actor);
    await depositService.recordPayment(ctx.clientId, ctx.tenantId, 10000, ctx.actor, null, {
      idempotencyKey: `tr-${ctx.tenancyId}`, tenancyId: ctx.tenancyId,
    });
    const key = `xfer-${ctx.tenancyId}`;
    await depositService.transfer(
      ctx.clientId,
      { fromTenancyId: ctx.tenancyId, toTenancyId: ctx.tenancy2Id, amountCents: 3000, reason: "unit_swap" },
      ctx.actor,
      null,
      { idempotencyKey: key }
    );
    const fromMid = await Deposit.findOne({ tenancyId: ctx.tenancyId }).lean();
    const toMid = await Deposit.findOne({ tenancyId: ctx.tenancy2Id }).lean();
    const out = await DepositMovement.findOne({ clientId: ctx.clientId, idempotencyKey: `${key}:out` }).lean();
    const inn = await DepositMovement.findOne({ clientId: ctx.clientId, idempotencyKey: `${key}:in` }).lean();
    expect(out).toBeTruthy();
    expect(inn).toBeTruthy();
    expect(out.amountCents).toBe(-3000);
    expect(inn.amountCents).toBe(3000);
    expect(String(inn.linkedMovementId)).toBe(String(out._id));
    expect(await Ledger.countDocuments({ referenceType: 'DepositMovement', referenceId: out._id })).toBe(1);
    expect(await Ledger.countDocuments({ referenceType: 'DepositMovement', referenceId: inn._id })).toBe(1);
    expect(await AuditLog.countDocuments({ action: 'DEPOSIT_TRANSFER', clientId: ctx.clientId })).toBeGreaterThanOrEqual(1);

    await depositService.transfer(
      ctx.clientId,
      { fromTenancyId: ctx.tenancyId, toTenancyId: ctx.tenancy2Id, amountCents: 3000, reason: "unit_swap" },
      ctx.actor,
      null,
      { idempotencyKey: key }
    );
    const fromAfter = await Deposit.findOne({ tenancyId: ctx.tenancyId }).lean();
    const toAfter = await Deposit.findOne({ tenancyId: ctx.tenancy2Id }).lean();
    expect(fromAfter.heldCents).toBe(fromMid.heldCents);
    expect(toAfter.heldCents).toBe(toMid.heldCents);
    expect(await DepositMovement.countDocuments({ clientId: ctx.clientId, type: 'TRANSFER_OUT' })).toBe(1);
    expect(await DepositMovement.countDocuments({ clientId: ctx.clientId, type: 'TRANSFER_IN' })).toBe(1);
  });

  test('one-sided transfer key fails closed', async () => {
    const ctx = await seed();
    await depositService.ensureRequired(ctx.clientId, { tenancyId: ctx.tenancyId, requiredCents: 5000 }, ctx.actor);
    await depositService.recordPayment(ctx.clientId, ctx.tenantId, 5000, ctx.actor, null, {
      idempotencyKey: `os-${ctx.tenancyId}`, tenancyId: ctx.tenancyId,
    });
    const dep = await Deposit.findOne({ tenancyId: ctx.tenancyId });
    // Inject only :out movement without :in
    await DepositMovement.create({
      clientId: ctx.clientId,
      estateId: dep.estateId,
      houseId: dep.houseId,
      tenantId: dep.tenantId,
      tenancyId: dep.tenancyId,
      depositId: dep._id,
      type: 'TRANSFER_OUT',
      amountCents: -1000,
      idempotencyKey: `broken-${ctx.tenancyId}:out`,
    });
    await expect(
      depositService.transfer(
        ctx.clientId,
        { fromTenancyId: ctx.tenancyId, toTenancyId: ctx.tenancy2Id, amountCents: 1000, reason: "broken_pair_probe" },
        ctx.actor,
        null,
        { idempotencyKey: `broken-${ctx.tenancyId}` }
      )
    ).rejects.toThrow(/incomplete|integrity/i);
  });

  test('key reuse with different amount fails without mutation', async () => {
    const ctx = await seed();
    await depositService.ensureRequired(ctx.clientId, { tenancyId: ctx.tenancyId, requiredCents: 10000 }, ctx.actor);
    await depositService.recordPayment(ctx.clientId, ctx.tenantId, 10000, ctx.actor, null, {
      idempotencyKey: `ra-${ctx.tenancyId}`, tenancyId: ctx.tenancyId,
    });
    const key = `diff-${ctx.tenancyId}`;
    await depositService.addDeduction(ctx.clientId, ctx.tenantId, { amountCents: 500, reason: 'a' }, ctx.actor, null, {
      idempotencyKey: key, tenancyId: ctx.tenancyId,
    });
    const mid = await Deposit.findOne({ tenancyId: ctx.tenancyId }).lean();
    await expect(
      depositService.addDeduction(ctx.clientId, ctx.tenantId, { amountCents: 600, reason: 'a' }, ctx.actor, null, {
        idempotencyKey: key, tenancyId: ctx.tenancyId,
      })
    ).rejects.toThrow(/different financial data|Conflict/i);
    const after = await Deposit.findOne({ tenancyId: ctx.tenancyId }).lean();
    expect(after.heldCents).toBe(mid.heldCents);
  });

  test('settlement writes the explicit audit event', async () => {
    const ctx = await seed();
    await depositService.ensureRequired(
      ctx.clientId,
      { tenancyId: ctx.tenancyId, requiredCents: 5000 },
      ctx.actor
    );

    await depositService.settleMoveOut(
      ctx.clientId, ctx.tenantId, ctx.actor
    );

    expect(await AuditLog.countDocuments({
      clientId: ctx.clientId,
      action: 'DEPOSIT_SETTLED',
    })).toBe(1);
  });

  test('payment replay refuses to recreate a missing Deposit aggregate', async () => {
    const ctx = await seed();
    await depositService.ensureRequired(
      ctx.clientId,
      { tenancyId: ctx.tenancyId, requiredCents: 5000 },
      ctx.actor
    );

    const key = `missing-deposit-${ctx.tenancyId}`;
    const args = [
      ctx.clientId, ctx.tenantId, 5000, ctx.actor, null,
      { idempotencyKey: key, tenancyId: ctx.tenancyId },
    ];

    await depositService.recordPayment(...args);
    await Deposit.deleteOne({ clientId: ctx.clientId, tenancyId: ctx.tenancyId });

    await expect(depositService.recordPayment(...args))
      .rejects.toThrow(/no Deposit aggregate/i);

    expect(await Deposit.countDocuments({
      clientId: ctx.clientId, tenancyId: ctx.tenancyId,
    })).toBe(0);

    expect(await DepositMovement.countDocuments({
      clientId: ctx.clientId, idempotencyKey: key,
    })).toBe(1);
  });

});
