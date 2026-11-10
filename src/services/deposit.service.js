// Deposit lifecycle — Tenancy-scoped; Ledger references DepositMovement.
// Idempotent mutations: lookup BEFORE aggregate changes.
import mongoose from 'mongoose';
import { Deposit } from '../models/Deposit.js';
import { DepositMovement } from '../models/DepositMovement.js';
import { Ledger } from '../models/Ledger.js';
import { Tenant } from '../models/Tenant.js';
import { Tenancy } from '../models/Tenancy.js';
import { Errors } from '../utils/errors.js';
import { estateFilterClause } from '../utils/estateFilter.js';
import { audit } from './audit.service.js';
import { AuditLog } from '../models/AuditLog.js';
import { ledgerService } from './ledger.service.js';
import { supportsMongoTransactions } from '../config/database.js';
import { requirePositiveSafeCents } from '../utils/moneyInt.js';
import { areFinancialIndexesReady } from '../utils/ensureIndexes.js';

const TYPE_TO_ENTRY = {
  RECEIVED: 'DEPOSIT_RECEIVED',
  DEDUCTION: 'DEPOSIT_DEDUCTION',
  REFUND: 'DEPOSIT_REFUND',
  TRANSFER_OUT: 'DEPOSIT_TRANSFER_OUT',
  TRANSFER_IN: 'DEPOSIT_TRANSFER_IN',
};

function requireReady() {
  if (supportsMongoTransactions() !== true) {
    throw Errors.ServiceUnavailable('MongoDB transactions required for deposit operations');
  }
  if (!areFinancialIndexesReady()) {
    throw Errors.ServiceUnavailable('Required financial indexes are not ready');
  }
}

function recomputeStatus(dep) {
  if (dep.refundedCents > 0 && dep.heldCents === 0) return 'REFUNDED';
  if (dep.settledAt) return 'SETTLED';
  if (dep.paidCents >= dep.requiredCents && dep.requiredCents > 0) return 'HELD';
  if (dep.paidCents > 0) return 'PARTIAL';
  return 'REQUIRED';
}

function parsePositive(amountCents, field = 'amountCents') {
  try {
    return requirePositiveSafeCents(amountCents, field);
  } catch {
    throw Errors.InvalidRequest(`${field} must be a positive safe integer`);
  }
}

function requireIdempotencyKey(key) {
  if (typeof key !== 'string' || !key.trim()) {
    throw Errors.InvalidRequest('Idempotency-Key header is required for this deposit mutation');
  }
  // Reserve room for transfer suffixes :out / :in (4 chars) within 128 index bound
  if (key.trim().length > 124) {
    throw Errors.InvalidRequest('Idempotency-Key must be at most 124 characters');
  }
  return key.trim();
}

function sameId(a, b) {
  return a != null && b != null && String(a) === String(b);
}

/**
 * Verify an existing movement fully matches expected financial identity and has matching Ledger.
 * Returns { ok: true, movement, ledger } or throws Conflict / fails closed.
 */
async function verifyExistingMovement(existing, expected, { session }) {
  const checks = [
    ['clientId', sameId(existing.clientId, expected.clientId)],
    ['estateId', sameId(existing.estateId, expected.estateId)],
    ['houseId', sameId(existing.houseId, expected.houseId)],
    ['tenantId', sameId(existing.tenantId, expected.tenantId)],
    ['tenancyId', sameId(existing.tenancyId, expected.tenancyId)],
    ['depositId', sameId(existing.depositId, expected.depositId)],
    ['type', existing.type === expected.type],
    ['amountCents', existing.amountCents === expected.signedAmount],
  ];
  if (expected.linkedMovementId != null) {
    checks.push(['linkedMovementId', sameId(existing.linkedMovementId, expected.linkedMovementId)]);
  }
  const bad = checks.filter(([, ok]) => !ok).map(([k]) => k);
  if (bad.length) {
    throw Errors.Conflict(`Idempotency key reused with different financial data (${bad.join(', ')})`);
  }

  const ledger = await Ledger.findOne({
    clientId: expected.clientId,
    referenceType: 'DepositMovement',
    referenceId: existing._id,
    entryType: TYPE_TO_ENTRY[expected.type],
  }).session(session).lean();

  if (!ledger) {
    throw Errors.Conflict(
      'Deposit movement exists without matching Ledger entry; manual review required'
    );
  }
  if (ledger.amountCents !== expected.signedAmount
    || ledger.accountCategory !== 'DEPOSIT'
    || ledger.entryType !== TYPE_TO_ENTRY[expected.type]
    || String(ledger.tenancyId) !== String(expected.tenancyId)
    || String(ledger.clientId) !== String(expected.clientId)
    || String(ledger.estateId) !== String(expected.estateId)
    || String(ledger.houseId) !== String(expected.houseId)
    || String(ledger.tenantId || '') !== String(expected.tenantId || '')
    || String(ledger.referenceId) !== String(existing._id)) {
    throw Errors.Conflict(
      'Deposit Ledger counterpart does not match movement; manual review required'
    );
  }
  const dup = await Ledger.countDocuments({
    clientId: expected.clientId,
    referenceType: 'DepositMovement',
    referenceId: existing._id,
    entryType: TYPE_TO_ENTRY[expected.type],
  }).session(session);
  if (dup > 1) {
    throw Errors.Conflict('Duplicate Ledger rows for deposit movement; integrity failure');
  }
  return { movement: existing, ledger };
}

async function findMovementByKey(clientId, idempotencyKey, session) {
  return DepositMovement.findOne({ clientId, idempotencyKey }).session(session);
}

async function createMovementAndLedger({
  session, clientId, estateId, houseId, tenantId, tenancyId, depositId,
  type, signedAmount, actorUserId, idempotencyKey, linkedMovementId, notes,
}) {
  const [movement] = await DepositMovement.create([{
    clientId, estateId, houseId, tenantId, tenancyId, depositId,
    type, amountCents: signedAmount, actorUserId: actorUserId || null,
    idempotencyKey: idempotencyKey || null,
    linkedMovementId: linkedMovementId || null,
    notes: notes || '',
  }], { session });

  await ledgerService.postEntry({
    clientId, estateId, houseId, tenantId, tenancyId,
    accountCategory: 'DEPOSIT',
    entryType: TYPE_TO_ENTRY[type],
    amountCents: signedAmount,
    referenceType: 'DepositMovement',
    referenceId: movement._id,
    description: notes || type,
  }, { session });

  return { movement, reused: false };
}

async function resolveActiveTenancy(clientId, tenantId, estateFilter) {
  const tenant = await Tenant.findOne({
    _id: tenantId, clientId, ...estateFilterClause(estateFilter),
  });
  if (!tenant) throw Errors.TenantNotFound();
  const tenancy = await Tenancy.findOne({ clientId, tenantId, status: 'ACTIVE' });
  if (!tenancy) {
    throw Errors.InvalidRequest('No ACTIVE tenancy for tenant; supply tenancy-scoped operation');
  }
  if (estateFilter?.estateId && String(tenancy.estateId) !== String(estateFilter.estateId)) {
    throw Errors.NotFound('Tenancy not found');
  }
  return { tenant, tenancy };
}

export const depositService = {
  async getForTenant(clientId, tenantId, estateFilter = null) {
    const tenant = await Tenant.findOne({
      _id: tenantId, clientId, ...estateFilterClause(estateFilter),
    }).lean();
    if (!tenant) throw Errors.TenantNotFound();
    const active = await Tenancy.findOne({ clientId, tenantId, status: 'ACTIVE' }).lean();
    let dep = null;
    if (active) dep = await Deposit.findOne({ clientId, tenancyId: active._id }).lean();
    if (!dep) dep = await Deposit.findOne({ clientId, tenantId, tenancyId: null }).lean();
    const bal = active
      ? await ledgerService.balanceForTenancy(clientId, active._id, 'DEPOSIT')
      : null;
    return { tenant, deposit: dep, activeTenancyId: active?._id || null, balance: bal };
  },

  async getForTenancy(clientId, tenancyId, estateFilter = null) {
    const tenancy = await Tenancy.findOne({
      _id: tenancyId, clientId, ...estateFilterClause(estateFilter),
    }).lean();
    if (!tenancy) throw Errors.NotFound('Tenancy not found');
    const dep = await Deposit.findOne({ clientId, tenancyId }).lean();
    const balance = await ledgerService.balanceForTenancy(clientId, tenancyId, 'DEPOSIT');
    return { tenancy, deposit: dep, balance };
  },

  async ensureRequired(clientId, { tenantId, tenancyId, requiredCents, moveInDate }, actor, estateFilter = null) {
    requireReady();
    const amount = requiredCents === 0 || requiredCents === '0'
      ? 0
      : parsePositive(requiredCents, 'requiredCents');
    let tenancy;
    if (tenancyId) {
      tenancy = await Tenancy.findOne({ _id: tenancyId, clientId, ...estateFilterClause(estateFilter) });
    } else if (tenantId) {
      ({ tenancy } = await resolveActiveTenancy(clientId, tenantId, estateFilter));
    } else {
      throw Errors.InvalidRequest('tenancyId or tenantId required');
    }
    if (!tenancy) throw Errors.NotFound('Tenancy not found');
    const session = await mongoose.startSession();
    try {
      let dep;
      await session.withTransaction(async () => {
        dep = await Deposit.findOne({ clientId, tenancyId: tenancy._id }).session(session);
        if (dep) {
          if (dep.paidCents === 0) {
            dep.requiredCents = amount;
            dep.moveInDate = moveInDate || dep.moveInDate;
            dep.status = recomputeStatus(dep);
            await dep.save({ session });
          }
          return;
        }
        const [created] = await Deposit.create([{
          clientId, estateId: tenancy.estateId, houseId: tenancy.houseId,
          tenantId: tenancy.tenantId, tenancyId: tenancy._id,
          requiredCents: amount, paidCents: 0, heldCents: 0, refundedCents: 0,
          status: amount > 0 ? 'REQUIRED' : 'HELD',
          moveInDate: moveInDate || tenancy.startAt,
        }], { session });
        dep = created;
      });
      await audit({
        clientId, userId: actor?._id, action: 'DEPOSIT_REQUIRED',
        resource: 'Deposit', resourceId: dep._id,
        metadata: { requiredCents: amount, tenancyId: String(tenancy._id) },
      });
      return dep;
    } finally {
      session.endSession();
    }
  },

  async recordPayment(clientId, tenantIdOrTenancy, amountCents, actor, estateFilter = null, { idempotencyKey, tenancyId } = {}) {
    requireReady();
    const key = requireIdempotencyKey(idempotencyKey);
    const amount = parsePositive(amountCents);
    let tenancy;
    if (tenancyId) {
      tenancy = await Tenancy.findOne({ _id: tenancyId, clientId, ...estateFilterClause(estateFilter) });
    } else {
      ({ tenancy } = await resolveActiveTenancy(clientId, tenantIdOrTenancy, estateFilter));
    }
    if (!tenancy) throw Errors.NotFound('Tenancy not found');

    const session = await mongoose.startSession();
    try {
      let dep;
      let movementResult;
      await session.withTransaction(async () => {
        const existing = await findMovementByKey(clientId, key, session);
        dep = await Deposit.findOne({ clientId, tenancyId: tenancy._id }).session(session);

        if (existing) {
          if (!dep) {
            throw Errors.Conflict('Existing deposit movement has no Deposit aggregate; manual review required');
          }
          await verifyExistingMovement(existing, {
            clientId, estateId: tenancy.estateId, houseId: tenancy.houseId,
            tenantId: tenancy.tenantId, tenancyId: tenancy._id, depositId: dep._id,
            type: 'RECEIVED', signedAmount: amount,
          }, { session });
          movementResult = { movement: existing, reused: true };
          return;
        }

        if (!dep) {
          const [created] = await Deposit.create([{
            clientId, estateId: tenancy.estateId, houseId: tenancy.houseId,
            tenantId: tenancy.tenantId, tenancyId: tenancy._id,
            requiredCents: amount, paidCents: 0, heldCents: 0, refundedCents: 0, status: 'REQUIRED',
          }], { session });
          dep = created;
        }

        movementResult = await createMovementAndLedger({
          session, clientId, estateId: tenancy.estateId, houseId: tenancy.houseId,
          tenantId: tenancy.tenantId, tenancyId: tenancy._id, depositId: dep._id,
          type: 'RECEIVED', signedAmount: amount, actorUserId: actor?._id,
          idempotencyKey: key, notes: 'Deposit received',
        });
        dep.paidCents += amount;
        dep.heldCents += amount;
        dep.status = recomputeStatus(dep);
        await dep.save({ session });
      });
      if (movementResult && !movementResult.reused) {
        await audit({
          clientId, userId: actor?._id, action: 'DEPOSIT_RECEIVED', resource: 'Deposit',
          resourceId: dep._id,
          metadata: { amountCents: amount, tenancyId: String(tenancy._id), movementId: String(movementResult.movement._id) },
        });
      }
      return dep;
    } finally {
      session.endSession();
    }
  },

  async addDeduction(clientId, tenantIdOrTenancy, { amountCents, reason, notes }, actor, estateFilter = null, { idempotencyKey, tenancyId } = {}) {
    requireReady();
    const key = requireIdempotencyKey(idempotencyKey);
    const amount = parsePositive(amountCents);
    if (!reason?.trim()) throw Errors.InvalidRequest('Deduction reason is required');
    let tenancy;
    if (tenancyId) {
      tenancy = await Tenancy.findOne({ _id: tenancyId, clientId, ...estateFilterClause(estateFilter) });
    } else {
      ({ tenancy } = await resolveActiveTenancy(clientId, tenantIdOrTenancy, estateFilter));
    }
    if (!tenancy) throw Errors.NotFound('Tenancy not found');

    const session = await mongoose.startSession();
    try {
      let dep;
      let movementReused = false;
      await session.withTransaction(async () => {
        dep = await Deposit.findOne({ clientId, tenancyId: tenancy._id }).session(session);
        if (!dep) throw Errors.NotFound('Deposit not found');

        const existing = await findMovementByKey(clientId, key, session);
        if (existing) {
          await verifyExistingMovement(existing, {
            clientId, estateId: tenancy.estateId, houseId: tenancy.houseId,
            tenantId: tenancy.tenantId, tenancyId: tenancy._id, depositId: dep._id,
            type: 'DEDUCTION', signedAmount: -amount,
          }, { session });
          movementReused = true;
          return; // no aggregate mutation
        }

        const updated = await Deposit.findOneAndUpdate(
          { _id: dep._id, heldCents: { $gte: amount } },
          { $inc: { heldCents: -amount } },
          { session, new: true }
        );
        if (!updated) throw Errors.InvalidRequest('Deduction exceeds held deposit');
        dep = updated;
        dep.deductions = dep.deductions || [];
        dep.deductions.push({
          amountCents: amount, reason: reason.trim(), notes: notes || '',
          actorUserId: actor?._id, deductedAt: new Date(),
        });
        dep.status = recomputeStatus(dep);
        await dep.save({ session });
        await createMovementAndLedger({
          session, clientId, estateId: tenancy.estateId, houseId: tenancy.houseId,
          tenantId: tenancy.tenantId, tenancyId: tenancy._id, depositId: dep._id,
          type: 'DEDUCTION', signedAmount: -amount, actorUserId: actor?._id,
          idempotencyKey: key, notes: `Deduction: ${reason.trim()}`,
        });
      });
      if (!movementReused) {
        await audit({
          clientId, userId: actor?._id, action: 'DEPOSIT_DEDUCTION',
          resource: 'Deposit', resourceId: dep._id,
          metadata: { amountCents: amount, reason: reason.trim() },
        });
      }
      return dep;
    } finally {
      session.endSession();
    }
  },

  async refund(clientId, tenantIdOrTenancy, amountCents, actor, estateFilter = null, { idempotencyKey, tenancyId } = {}) {
    requireReady();
    const key = requireIdempotencyKey(idempotencyKey);
    const amount = parsePositive(amountCents);
    let tenancy;
    if (tenancyId) {
      tenancy = await Tenancy.findOne({ _id: tenancyId, clientId, ...estateFilterClause(estateFilter) });
    } else {
      ({ tenancy } = await resolveActiveTenancy(clientId, tenantIdOrTenancy, estateFilter));
    }
    if (!tenancy) throw Errors.NotFound('Tenancy not found');

    const session = await mongoose.startSession();
    try {
      let dep;
      let movementReused = false;
      await session.withTransaction(async () => {
        dep = await Deposit.findOne({ clientId, tenancyId: tenancy._id }).session(session);
        if (!dep) throw Errors.NotFound('Deposit not found');

        const existing = await findMovementByKey(clientId, key, session);
        if (existing) {
          await verifyExistingMovement(existing, {
            clientId, estateId: tenancy.estateId, houseId: tenancy.houseId,
            tenantId: tenancy.tenantId, tenancyId: tenancy._id, depositId: dep._id,
            type: 'REFUND', signedAmount: -amount,
          }, { session });
          movementReused = true;
          return;
        }

        const updated = await Deposit.findOneAndUpdate(
          { _id: dep._id, heldCents: { $gte: amount } },
          { $inc: { heldCents: -amount, refundedCents: amount } },
          { session, new: true }
        );
        if (!updated) throw Errors.InvalidRequest('Refund exceeds held deposit');
        dep = updated;
        dep.status = recomputeStatus(dep);
        await dep.save({ session });
        await createMovementAndLedger({
          session, clientId, estateId: tenancy.estateId, houseId: tenancy.houseId,
          tenantId: tenancy.tenantId, tenancyId: tenancy._id, depositId: dep._id,
          type: 'REFUND', signedAmount: -amount, actorUserId: actor?._id,
          idempotencyKey: key, notes: 'Deposit refund',
        });
      });
      if (!movementReused) {
        await audit({
          clientId, userId: actor?._id, action: 'DEPOSIT_REFUND',
          resource: 'Deposit', resourceId: dep._id,
          metadata: { amountCents: amount },
        });
      }
      return dep;
    } finally {
      session.endSession();
    }
  },

  async settle(clientId, tenantIdOrTenancy, actor, estateFilter = null, { tenancyId } = {}) {
    requireReady();
    let tenancy;
    if (tenancyId) {
      tenancy = await Tenancy.findOne({ _id: tenancyId, clientId, ...estateFilterClause(estateFilter) });
    } else {
      ({ tenancy } = await resolveActiveTenancy(clientId, tenantIdOrTenancy, estateFilter));
    }
    if (!tenancy) throw Errors.NotFound('Tenancy not found');
    const session = await mongoose.startSession();
    try {
      let dep;
      await session.withTransaction(async () => {
        dep = await Deposit.findOne({ clientId, tenancyId: tenancy._id }).session(session);
        if (!dep) throw Errors.NotFound('Deposit not found');
        dep.settledAt = new Date();
        dep.status = recomputeStatus(dep);
        await dep.save({ session });
      });
      await audit({
        clientId, userId: actor?._id, action: 'DEPOSIT_SETTLED',
        resource: 'Deposit', resourceId: dep._id,
        metadata: { tenancyId: String(tenancy._id) },
      });
      return dep;
    } finally {
      session.endSession();
    }
  },

  /** Alias used by existing controller */
  async settleMoveOut(clientId, tenantId, actor, estateFilter = null) {
    return this.settle(clientId, tenantId, actor, estateFilter);
  },

  async transfer(clientId, { fromTenancyId, toTenancyId, amountCents, reason }, actor, estateFilter = null, { idempotencyKey } = {}) {
    requireReady();
    const key = requireIdempotencyKey(idempotencyKey);
    const amount = parsePositive(amountCents);
    if (!actor?._id) {
      throw Errors.InvalidRequest('User-authorized deposit transfer requires an initiating actor');
    }
    const transferReason = typeof reason === 'string' ? reason.trim() : '';
    if (!transferReason || transferReason.length > 500) {
      throw Errors.InvalidRequest('Transfer reason is required');
    }
    if (String(fromTenancyId) === String(toTenancyId)) {
      throw Errors.InvalidRequest('Source and destination tenancies must differ');
    }
    const fromT = await Tenancy.findOne({ _id: fromTenancyId, clientId, ...estateFilterClause(estateFilter) });
    const toT = await Tenancy.findOne({ _id: toTenancyId, clientId, ...estateFilterClause(estateFilter) });
    if (!fromT || !toT) throw Errors.NotFound('Tenancy not found');

    const outKey = `${key}:out`;
    const inKey = `${key}:in`;

    const session = await mongoose.startSession();
    try {
      let fromDep; let toDep;
      await session.withTransaction(async () => {
        fromDep = await Deposit.findOne({ clientId, tenancyId: fromTenancyId }).session(session);
        if (!fromDep) throw Errors.NotFound('Source deposit not found');
        toDep = await Deposit.findOne({ clientId, tenancyId: toTenancyId }).session(session);

        const existingOut = await findMovementByKey(clientId, outKey, session);
        const existingIn = await findMovementByKey(clientId, inKey, session);

        if (existingOut || existingIn) {
          if (!existingOut || !existingIn) {
            throw Errors.Conflict('Transfer pair incomplete; one-sided movement is an integrity failure');
          }
          await verifyExistingMovement(existingOut, {
            clientId, estateId: fromT.estateId, houseId: fromT.houseId,
            tenantId: fromT.tenantId, tenancyId: fromT._id, depositId: fromDep._id,
            type: 'TRANSFER_OUT', signedAmount: -amount,
          }, { session });
          if (!toDep) throw Errors.Conflict('Transfer inbound deposit missing; integrity failure');
          await verifyExistingMovement(existingIn, {
            clientId, estateId: toT.estateId, houseId: toT.houseId,
            tenantId: toT.tenantId, tenancyId: toT._id, depositId: toDep._id,
            type: 'TRANSFER_IN', signedAmount: amount, linkedMovementId: existingOut._id,
          }, { session });
          if (!sameId(existingIn.linkedMovementId, existingOut._id)) {
            throw Errors.Conflict('Transfer legs not linked; integrity failure');
          }
          return; // replay complete — no aggregate mutation
        }

        const updated = await Deposit.findOneAndUpdate(
          { _id: fromDep._id, heldCents: { $gte: amount } },
          { $inc: { heldCents: -amount } },
          { session, new: true }
        );
        if (!updated) throw Errors.InvalidRequest('Transfer exceeds held deposit');
        fromDep = updated;
        fromDep.status = recomputeStatus(fromDep);
        await fromDep.save({ session });

        if (!toDep) {
          const [created] = await Deposit.create([{
            clientId, estateId: toT.estateId, houseId: toT.houseId,
            tenantId: toT.tenantId, tenancyId: toT._id,
            requiredCents: 0, paidCents: 0, heldCents: 0, refundedCents: 0, status: 'REQUIRED',
          }], { session });
          toDep = created;
        }
        toDep.heldCents += amount;
        toDep.paidCents += amount;
        toDep.status = recomputeStatus(toDep);
        await toDep.save({ session });

        const out = await createMovementAndLedger({
          session, clientId, estateId: fromT.estateId, houseId: fromT.houseId,
          tenantId: fromT.tenantId, tenancyId: fromT._id, depositId: fromDep._id,
          type: 'TRANSFER_OUT', signedAmount: -amount, actorUserId: actor._id,
          idempotencyKey: outKey, notes: `Transfer to ${toTenancyId}: ${transferReason}`,
        });
        const inn = await createMovementAndLedger({
          session, clientId, estateId: toT.estateId, houseId: toT.houseId,
          tenantId: toT.tenantId, tenancyId: toT._id, depositId: toDep._id,
          type: 'TRANSFER_IN', signedAmount: amount, actorUserId: actor._id,
          idempotencyKey: inKey, linkedMovementId: out.movement._id,
          notes: `Transfer from ${fromTenancyId}: ${transferReason}`,
        });
        // Durable compliance audit — same Mongo transaction as both legs + ledger
        await AuditLog.create([{
          clientId,
          estateId: fromT.estateId,
          userId: actor._id,
          action: 'DEPOSIT_TRANSFER',
          resource: 'Deposit',
          resourceId: fromDep._id,
          description: transferReason,
          metadata: {
            amountCents: amount,
            currency: 'KES',
            amountUnit: 'cents',
            fromTenancyId: String(fromTenancyId),
            toTenancyId: String(toTenancyId),
            fromDepositId: String(fromDep._id),
            toDepositId: String(toDep._id),
            outMovementId: String(out.movement._id),
            inMovementId: String(inn.movement._id),
            reason: transferReason,
          },
        }], { session });

      });
      return { from: fromDep, to: toDep };
    } finally {
      session.endSession();
    }
  },
};
