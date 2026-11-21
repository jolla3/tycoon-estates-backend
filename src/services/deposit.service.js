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

const OBJECT_ID = /^[a-f\d]{24}$/i;

/**
 * Tenancy statuses that may take part in each deposit operation.
 * Incoming money and requirement changes need a live (ACTIVE) tenancy.
 * Operations on money already held (deduct/refund/settle) and reads must also
 * work after move-out (CLOSED). VOID tenancies are corrections and never
 * participate. Fail-closed: anything not listed is refused.
 */
const OPERATION_STATUSES = {
  read: ['ACTIVE', 'CLOSED'],
  require: ['ACTIVE'],
  pay: ['ACTIVE'],
  deduct: ['ACTIVE', 'CLOSED'],
  refund: ['ACTIVE', 'CLOSED'],
  settle: ['ACTIVE', 'CLOSED'],
};

function assertObjectId(value, field) {
  if (!OBJECT_ID.test(String(value ?? ''))) {
    throw Errors.InvalidRequest(`${field} is not a valid identifier`);
  }
}

function assertStatusPermitted(tenancy, operation) {
  const allowed = OPERATION_STATUSES[operation];
  if (!allowed || !allowed.includes(tenancy.status)) {
    throw Errors.TenancyNotEligible(
      `A ${tenancy.status} tenancy cannot be used for this deposit operation`,
      { tenancyStatus: tenancy.status, operation }
    );
  }
}

/**
 * Resolve the EXACT Tenancy a deposit operation applies to. Never picks an
 * arbitrary row.
 *
 *  - tenancyId supplied: the Tenancy must exist under {clientId, estate scope}
 *    and, when tenantId is also supplied, belong to that Tenant. A mismatch is
 *    reported as "not found" so another client's or tenant's ids are never
 *    confirmed to exist.
 *  - tenancyId omitted (legacy tenant-keyed request): allowed only when the
 *    Tenant has EXACTLY ONE ACTIVE Tenancy inside the caller's estate scope.
 *    Zero is an invalid request; more than one is a typed 409 so the client
 *    must choose explicitly.
 *
 * Estate scope comes from req.estateFilter (server-derived from the session),
 * never from a body field.
 */
async function resolveExactTenancy(clientId, { tenantId, tenancyId, estateId }, estateFilter, operation) {
  if (estateId) assertObjectId(estateId, 'estateId');
  let tenant = null;
  if (tenantId) {
    assertObjectId(tenantId, 'tenantId');
    // Estate scope is enforced on the Tenancy (the authority for estate); a
    // Tenant's own estateId only reflects one of possibly several tenancies.
    tenant = await Tenant.findOne({ _id: tenantId, clientId });
    if (!tenant) throw Errors.TenantNotFound();
  }

  if (tenancyId) {
    assertObjectId(tenancyId, 'tenancyId');
    const tenancy = await Tenancy.findOne({
      _id: tenancyId, clientId, ...estateFilterClause(estateFilter),
    });
    if (
      !tenancy
      || (tenantId && !sameId(tenancy.tenantId, tenantId))
      || (estateId && !sameId(tenancy.estateId, estateId))
    ) {
      throw Errors.NotFound('Tenancy not found');
    }
    assertStatusPermitted(tenancy, operation);
    return { tenant, tenancy };
  }

  if (!tenantId) throw Errors.InvalidRequest('tenancyId or tenantId required');

  const filter = { clientId, tenantId, status: 'ACTIVE', ...estateFilterClause(estateFilter) };
  if (estateId) filter.estateId = estateId;
  const candidates = await Tenancy.find(filter).sort({ _id: 1 }).limit(2);
  if (candidates.length === 0) {
    throw Errors.InvalidRequest('No ACTIVE tenancy for tenant; supply tenancy-scoped operation');
  }
  if (candidates.length > 1) {
    throw Errors.DepositTenancyAmbiguous(undefined, {
      eligibleTenancyCount: await Tenancy.countDocuments(filter),
    });
  }
  assertStatusPermitted(candidates[0], operation);
  return { tenant, tenancy: candidates[0] };
}

/**
 * Re-verify, inside the write transaction, that the Tenancy resolved earlier
 * still has the same identity and a permitted status. Closes the window between
 * resolution and write (e.g. a concurrent move-out).
 */
async function assertTenancyStillEligible(clientId, tenancy, operation, session) {
  const fresh = await Tenancy.findOne({
    _id: tenancy._id,
    clientId,
    tenantId: tenancy.tenantId,
    estateId: tenancy.estateId,
    houseId: tenancy.houseId,
  }).session(session).lean();
  if (!fresh) throw Errors.NotFound('Tenancy not found');
  assertStatusPermitted(fresh, operation);
}

export const depositService = {
  /**
   * Tenant-keyed read. Never guesses between tenancies: with exactly one ACTIVE
   * tenancy in scope it returns that deposit; with several it returns
   * `deposit: null`, `activeTenancyId: null` and the eligible tenancy ids so the
   * caller must pick one (then use getForTenancy).
   */
  async getForTenant(clientId, tenantId, estateFilter = null) {
    assertObjectId(tenantId, 'tenantId');
    const tenant = await Tenant.findOne({
      _id: tenantId, clientId, ...estateFilterClause(estateFilter),
    }).lean();
    if (!tenant) throw Errors.TenantNotFound();
    const actives = await Tenancy.find({
      clientId, tenantId, status: 'ACTIVE', ...estateFilterClause(estateFilter),
    }).sort({ _id: 1 }).lean();
    const eligibleTenancyIds = actives.map((t) => t._id);
    if (actives.length > 1) {
      return {
        tenant, deposit: null, activeTenancyId: null, balance: null,
        eligibleTenancyCount: actives.length, eligibleTenancyIds, ambiguous: true,
      };
    }
    const active = actives[0] || null;
    let dep = null;
    if (active) dep = await Deposit.findOne({ clientId, tenancyId: active._id }).lean();
    if (!dep && !active) dep = await Deposit.findOne({ clientId, tenantId, tenancyId: null }).lean();
    const bal = active
      ? await ledgerService.balanceForTenancy(clientId, active._id, 'DEPOSIT')
      : null;
    return {
      tenant, deposit: dep, activeTenancyId: active?._id || null, balance: bal,
      eligibleTenancyCount: actives.length, eligibleTenancyIds, ambiguous: false,
    };
  },

  /** Exact read: {tenantId?, tenancyId, estateId?} validated together. */
  async getExact(clientId, { tenantId, tenancyId, estateId }, estateFilter = null) {
    const { tenancy } = await resolveExactTenancy(
      clientId, { tenantId, tenancyId, estateId }, estateFilter, 'read'
    );
    const deposit = await Deposit.findOne({ clientId, tenancyId: tenancy._id }).lean();
    const balance = await ledgerService.balanceForTenancy(clientId, tenancy._id, 'DEPOSIT');
    return { tenancy, deposit, balance, activeTenancyId: tenancy._id, ambiguous: false };
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

  async ensureRequired(clientId, { tenantId, tenancyId, estateId, requiredCents, moveInDate }, actor, estateFilter = null) {
    requireReady();
    const amount = requiredCents === 0 || requiredCents === '0'
      ? 0
      : parsePositive(requiredCents, 'requiredCents');
    const { tenancy } = await resolveExactTenancy(clientId, { tenantId, tenancyId, estateId }, estateFilter, 'require');
    const session = await mongoose.startSession();
    try {
      let dep;
      let unchanged = false;
      let lockedDetails = null;
      await session.withTransaction(async () => {
        await assertTenancyStillEligible(clientId, tenancy, 'require', session);
        dep = await Deposit.findOne({ clientId, tenancyId: tenancy._id }).session(session);
        if (dep) {
          if (dep.paidCents === 0) {
            dep.requiredCents = amount;
            dep.moveInDate = moveInDate || dep.moveInDate;
            dep.status = recomputeStatus(dep);
            await dep.save({ session });
            return;
          }
          // Money already received: the requirement is locked. Same value is a
          // no-op (retry-safe, no write, no audit); a different value is refused
          // rather than silently ignored. No adjustment/refund is implied.
          if (dep.requiredCents === amount) {
            unchanged = true;
            return;
          }
          lockedDetails = {
            tenancyId: String(tenancy._id),
            requiredCents: dep.requiredCents,
            requestedCents: amount,
            paidCents: dep.paidCents,
            heldCents: dep.heldCents,
            refundedCents: dep.refundedCents,
            status: dep.status,
          };
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
      if (lockedDetails) {
        await audit({
          clientId, userId: actor?._id, action: 'DEPOSIT_REQUIREMENT_CHANGE_REFUSED',
          resource: 'Deposit', resourceId: dep._id,
          metadata: lockedDetails,
        });
        throw Errors.DepositRequirementLocked(undefined, lockedDetails);
      }
      if (unchanged) return dep;
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

  async recordPayment(clientId, tenantIdOrTenancy, amountCents, actor, estateFilter = null, { idempotencyKey, tenancyId, estateId } = {}) {
    requireReady();
    const key = requireIdempotencyKey(idempotencyKey);
    const amount = parsePositive(amountCents);
    const { tenancy } = await resolveExactTenancy(
      clientId, { tenantId: tenantIdOrTenancy, tenancyId, estateId }, estateFilter, 'pay'
    );

    const session = await mongoose.startSession();
    try {
      let dep;
      let movementResult;
      await session.withTransaction(async () => {
        const existing = await findMovementByKey(clientId, key, session);
        if (!existing) await assertTenancyStillEligible(clientId, tenancy, 'pay', session);
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

  async addDeduction(clientId, tenantIdOrTenancy, { amountCents, reason, notes }, actor, estateFilter = null, { idempotencyKey, tenancyId, estateId } = {}) {
    requireReady();
    const key = requireIdempotencyKey(idempotencyKey);
    const amount = parsePositive(amountCents);
    if (!reason?.trim()) throw Errors.InvalidRequest('Deduction reason is required');
    const { tenancy } = await resolveExactTenancy(
      clientId, { tenantId: tenantIdOrTenancy, tenancyId, estateId }, estateFilter, 'deduct'
    );

    const session = await mongoose.startSession();
    try {
      let dep;
      let movementReused = false;
      await session.withTransaction(async () => {
        dep = await Deposit.findOne({ clientId, tenancyId: tenancy._id }).session(session);
        if (!dep) throw Errors.NotFound('Deposit not found');

        const existing = await findMovementByKey(clientId, key, session);
        if (!existing) await assertTenancyStillEligible(clientId, tenancy, 'deduct', session);
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

  async refund(clientId, tenantIdOrTenancy, amountCents, actor, estateFilter = null, { idempotencyKey, tenancyId, estateId } = {}) {
    requireReady();
    const key = requireIdempotencyKey(idempotencyKey);
    const amount = parsePositive(amountCents);
    const { tenancy } = await resolveExactTenancy(
      clientId, { tenantId: tenantIdOrTenancy, tenancyId, estateId }, estateFilter, 'refund'
    );

    const session = await mongoose.startSession();
    try {
      let dep;
      let movementReused = false;
      await session.withTransaction(async () => {
        dep = await Deposit.findOne({ clientId, tenancyId: tenancy._id }).session(session);
        if (!dep) throw Errors.NotFound('Deposit not found');

        const existing = await findMovementByKey(clientId, key, session);
        if (!existing) await assertTenancyStillEligible(clientId, tenancy, 'refund', session);
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

  async settle(clientId, tenantIdOrTenancy, actor, estateFilter = null, { tenancyId, estateId } = {}) {
    requireReady();
    const { tenancy } = await resolveExactTenancy(
      clientId, { tenantId: tenantIdOrTenancy, tenancyId, estateId }, estateFilter, 'settle'
    );
    const session = await mongoose.startSession();
    try {
      let dep;
      await session.withTransaction(async () => {
        await assertTenancyStillEligible(clientId, tenancy, 'settle', session);
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
  async settleMoveOut(clientId, tenantId, actor, estateFilter = null, opts = {}) {
    return this.settle(clientId, tenantId, actor, estateFilter, opts);
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
