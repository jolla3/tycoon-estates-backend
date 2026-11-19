// src/services/tenancy.service.js
import mongoose from 'mongoose';
import { MpesaCollectionReference } from '../models/MpesaCollectionReference.js';
import { Tenancy } from '../models/Tenancy.js';
import { Tenant } from '../models/Tenant.js';
import { House } from '../models/House.js';
import { Errors } from '../utils/errors.js';
import { estateFilterClause } from '../utils/estateFilter.js';
import { supportsMongoTransactions } from '../config/database.js';
import {
  classifyTenanciesForPeriod, tenancyIneligibleReason, TENANCY_RESOLUTION,
} from '../utils/manualPaymentTenancy.js';

function requireTransactions() {
  if (supportsMongoTransactions() === false) {
    throw Errors.ServiceUnavailable(
      'MongoDB multi-document transactions are required for tenancy lifecycle operations'
    );
  }
}

export function tenancyContains(tenancy, eventTime) {
  if (!tenancy || (tenancy.status && !['ACTIVE', 'CLOSED'].includes(tenancy.status))) return false;
  const t = new Date(eventTime).getTime();
  const start = new Date(tenancy.startAt).getTime();
  if (!Number.isFinite(t) || !Number.isFinite(start) || t < start) return false;
  if (tenancy.endAt == null) return true;
  const end = new Date(tenancy.endAt).getTime();
  return Number.isFinite(end) && t < end; // endAt is exclusive
}

/** PayBill references are retired (never reassigned) in the same transaction as the tenancy close. */
async function retireTenancyReferences(clientId, tenancyId, session) {
  await MpesaCollectionReference.updateMany(
    { clientId, tenancyId, status: 'ACTIVE' },
    { $set: { status: 'RETIRED', retiredAt: new Date(), retiredReason: 'TENANCY_CLOSED' } },
    { session },
  );
}

export const tenancyService = {
  tenancyContains,

  async getActiveForHouse(clientId, houseId, { session } = {}) {
    return Tenancy.findOne({ clientId, houseId, status: 'ACTIVE' }).session(session || null);
  },

  async getById(clientId, tenancyId, estateFilter = null) {
    const t = await Tenancy.findOne({
      _id: tenancyId,
      clientId,
      ...estateFilterClause(estateFilter),
    }).lean();
    if (!t) throw Errors.NotFound('Tenancy not found');
    return t;
  },

  async listForTenant(clientId, tenantId, estateFilter = null) {
    return Tenancy.find({
      clientId,
      tenantId,
      ...estateFilterClause(estateFilter),
    })
      .sort({ startAt: -1 })
      .lean();
  },

  async findUniqueForHouseAt(clientId, houseId, eventTime, { session } = {}) {
    const at = new Date(eventTime);
    const candidates = await Tenancy.find({
      clientId,
      houseId,
      status: { $in: ['ACTIVE', 'CLOSED'] },
      startAt: { $lte: at },
      $or: [{ endAt: null }, { endAt: { $gt: at } }],
    })
      .session(session || null)
      .lean();
    if (candidates.length === 1) return candidates[0];
    return null;
  },

  /**
   * Resolve the single Tenancy a manual payment for (house, period) belongs to.
   * Explicit tenancyId is validated against client/estate/house/tenant/period;
   * otherwise exactly one eligible tenancy must exist. Fails closed.
   */
  async resolveForManualPayment(clientId, house, { period, tenancyId = null, tenantId = null }, { session } = {}) {
    const base = { clientId, houseId: house._id, estateId: house.estateId, status: { $in: ['ACTIVE', 'CLOSED'] } };
    if (tenancyId) {
      const t = await Tenancy.findOne({ ...base, _id: tenancyId }).session(session || null).lean();
      if (!t) throw Errors.InvalidRequest('Selected tenancy does not belong to this house');
      if (tenantId && String(t.tenantId) !== String(tenantId)) {
        throw Errors.InvalidRequest('Selected tenancy belongs to a different tenant');
      }
      const reason = tenancyIneligibleReason(t, period);
      if (reason) throw Errors.InvalidRequest(`Selected tenancy cannot take a payment for ${period}: ${reason}`);
      return t;
    }
    const candidates = await Tenancy.find(base).session(session || null).lean();
    const r = classifyTenanciesForPeriod(candidates, period, { tenantId });
    if (r.status === TENANCY_RESOLUTION.UNIQUE) return r.tenancy;
    if (r.status === TENANCY_RESOLUTION.AMBIGUOUS) {
      throw Errors.Conflict(`More than one tenancy covers ${period} for this house; choose which tenancy this payment is for`);
    }
    if (tenantId && classifyTenanciesForPeriod(candidates, period).status !== TENANCY_RESOLUTION.NONE) {
      throw Errors.InvalidRequest('tenantId does not match any tenancy covering this period for this house');
    }
    throw Errors.InvalidRequest(`No tenancy fully covers ${period} for this house; a payment cannot be attributed to a tenant`);
  },

  /**
   * Read model for the manual-payment form: human-readable tenancies for a house + period.
   * Period resolution uses EVERY tenancy that can cover the period (never a truncated "latest N"),
   * while the browsable option list is paginated and searchable by tenant name, so older
   * tenancies are always reachable and nothing unbounded is loaded.
   */
  async manualPaymentOptions(clientId, house, period, { page = 1, limit = 20, search = '' } = {}) {
    const pageSize = Math.min(Math.max(Number(limit) || 20, 1), 50);
    const pageNo = Math.max(Number(page) || 1, 1);
    const base = { clientId, houseId: house._id, estateId: house.estateId, status: { $in: ['ACTIVE', 'CLOSED'] } };

    // 1. Resolution over every candidate that could cover the period (DB prefilter is deliberately
    //    loose by 2 days; the exact boundary rule is applied in memory by classifyTenanciesForPeriod).
    const [y, m] = String(period).split('-').map(Number);
    const margin = 2 * 24 * 3600 * 1000;
    const periodStart = new Date(Date.UTC(y, m - 1, 1) - margin);
    const periodEnd = new Date(Date.UTC(y, m, 1) + margin);
    const candidates = await Tenancy.find({
      ...base,
      startAt: { $lte: periodEnd },
      $or: [{ endAt: null }, { endAt: { $gte: periodStart } }],
    }).sort({ startAt: -1 }).limit(200).lean();
    const r = classifyTenanciesForPeriod(candidates, period);

    // 2. Browsable page (optionally filtered by tenant name).
    const listFilter = { ...base };
    const term = String(search || '').trim().slice(0, 80);
    if (term) {
      const escaped = term.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      const matches = await Tenant.find({ clientId, name: { $regex: escaped, $options: 'i' } }).select('_id').limit(500).lean();
      listFilter.tenantId = { $in: matches.map((t) => t._id) };
    }
    const [pageRows, total] = await Promise.all([
      Tenancy.find(listFilter).sort({ startAt: -1, _id: -1 }).skip((pageNo - 1) * pageSize).limit(pageSize).lean(),
      Tenancy.countDocuments(listFilter),
    ]);

    const wanted = new Map();
    for (const t of [...pageRows, ...r.eligible]) wanted.set(String(t._id), t);
    const tenants = await Tenant.find({ clientId, _id: { $in: [...wanted.values()].map((t) => t.tenantId) } })
      .select('name').lean();
    const nameById = new Map(tenants.map((t) => [String(t._id), t.name]));
    const toOption = (t) => {
      const reason = tenancyIneligibleReason(t, period);
      return {
        tenancyId: String(t._id),
        tenantName: nameById.get(String(t.tenantId)) || 'Unknown tenant',
        startAt: t.startAt,
        endAt: t.endAt || null,
        status: t.status,
        coversPeriod: reason === null,
        reason,
      };
    };
    return {
      houseId: String(house._id),
      period,
      resolution: r.status,
      defaultTenancyId: r.status === TENANCY_RESOLUTION.UNIQUE ? String(r.tenancy._id) : null,
      // Always present regardless of page/search so the form can show who can take the payment.
      eligibleOptions: r.eligible.map(toOption),
      options: pageRows.map(toOption),
      page: pageNo,
      limit: pageSize,
      total,
      hasMore: pageNo * pageSize < total,
    };
  },

  async open({ clientId, estateId, houseId, tenantId, startAt, actorUserId = null }, { session: outer } = {}) {
    requireTransactions();
    const start = startAt ? new Date(startAt) : new Date();
    const run = async (session) => {
      const house = await House.findOne({ _id: houseId, clientId }).session(session);
      if (!house) throw Errors.HouseNotFound();
      if (house.isActive === false) {
        throw Errors.HouseNotFound('House is inactive and cannot receive a tenant');
      }
      if (house.status !== 'vacant' || house.tenantId) {
        throw Errors.Conflict('House is not vacant and cannot receive another tenant');
      }
      const existing = await Tenancy.findOne({ clientId, houseId, status: 'ACTIVE' }).session(session);
      if (existing) throw Errors.Conflict('House already has an active tenancy');
      let tenancy;
      try {
        const [created] = await Tenancy.create(
          [{
            clientId,
            estateId: estateId || house.estateId,
            houseId,
            tenantId,
            startAt: start,
            endAt: null,
            status: 'ACTIVE',
            openedByUserId: actorUserId,
          }],
          { session }
        );
        tenancy = created;
      } catch (err) {
        if (err?.code === 11000) throw Errors.Conflict('House already has an active tenancy');
        throw err;
      }
      house.tenantId = tenantId;
      house.status = 'occupied';
      await house.save({ session });
      await Tenant.updateOne(
        { _id: tenantId, clientId },
        { houseId, estateId: estateId || house.estateId, status: 'active', moveInDate: start, moveOutDate: null },
        { session }
      );
      return tenancy;
    };
    if (outer) return run(outer);
    const session = await mongoose.startSession();
    try {
      let result;
      await session.withTransaction(async () => { result = await run(session); });
      return result;
    } finally {
      session.endSession();
    }
  },

  async close(clientId, tenancyId, { endAt = null, reason = 'MOVE_OUT', actorUserId = null } = {}, { session: outer } = {}) {
    requireTransactions();
    const end = endAt ? new Date(endAt) : new Date();
    const run = async (session) => {
      const tenancy = await Tenancy.findOne({ _id: tenancyId, clientId }).session(session);
      if (!tenancy) throw Errors.NotFound('Tenancy not found');
      if (tenancy.status !== 'ACTIVE') throw Errors.Conflict('Tenancy is not active');
      tenancy.endAt = end;
      tenancy.status = 'CLOSED';
      tenancy.closeReason = reason;
      tenancy.closedByUserId = actorUserId;
      await tenancy.save({ session });
      await retireTenancyReferences(clientId, tenancy._id, session);
      await House.updateOne(
        { _id: tenancy.houseId, clientId, tenantId: tenancy.tenantId },
        { tenantId: null, status: 'vacant' },
        { session }
      );
      await Tenant.updateOne(
        { _id: tenancy.tenantId, clientId },
        { status: 'moved_out', moveOutDate: end },
        { session }
      );
      return tenancy;
    };
    if (outer) return run(outer);
    const session = await mongoose.startSession();
    try {
      let result;
      await session.withTransaction(async () => { result = await run(session); });
      return result;
    } finally {
      session.endSession();
    }
  },

  async moveToHouse(clientId, tenantId, newHouseId, estateFilter = null, actorUserId = null) {
    requireTransactions();
    const session = await mongoose.startSession();
    try {
      let newTenancy;
      await session.withTransaction(async () => {
        const tenant = await Tenant.findOne({
          _id: tenantId, clientId, ...estateFilterClause(estateFilter),
        }).session(session);
        if (!tenant) throw Errors.TenantNotFound();
        const newHouse = await House.findOne({
          _id: newHouseId, clientId, isActive: true, ...estateFilterClause(estateFilter),
        }).session(session);
        if (!newHouse) throw Errors.HouseNotFound('Target house not found for your client');
        const activeOnTarget = await Tenancy.findOne({ houseId: newHouse._id, status: 'ACTIVE' }).session(session);
        if (activeOnTarget && !activeOnTarget.tenantId.equals(tenant._id)) {
          throw Errors.Conflict('Target house already has a tenant');
        }
        const current = await Tenancy.findOne({ clientId, tenantId: tenant._id, status: 'ACTIVE' }).session(session);
        const now = new Date();
        if (current) {
          if (current.houseId.equals(newHouse._id)) {
            newTenancy = current;
            return;
          }
          current.endAt = now;
          current.status = 'CLOSED';
          current.closeReason = 'TRANSFER';
          current.closedByUserId = actorUserId;
          await current.save({ session });
          await retireTenancyReferences(clientId, current._id, session);
          await House.updateOne(
            { _id: current.houseId, clientId },
            { tenantId: null, status: 'vacant' },
            { session }
          );
        }
        try {
          const [created] = await Tenancy.create(
            [{
              clientId,
              estateId: newHouse.estateId,
              houseId: newHouse._id,
              tenantId: tenant._id,
              startAt: now,
              endAt: null,
              status: 'ACTIVE',
              openedByUserId: actorUserId,
            }],
            { session }
          );
          newTenancy = created;
        } catch (err) {
          if (err?.code === 11000) throw Errors.Conflict('Target house already has an active tenancy');
          throw err;
        }
        newHouse.tenantId = tenant._id;
        newHouse.status = 'occupied';
        await newHouse.save({ session });
        tenant.houseId = newHouse._id;
        tenant.estateId = newHouse.estateId;
        tenant.status = 'active';
        tenant.moveInDate = now;
        tenant.moveOutDate = null;
        await tenant.save({ session });
      });
      return newTenancy;
    } finally {
      session.endSession();
    }
  },
};
