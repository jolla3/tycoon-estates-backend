// src/services/tenancy.service.js
import mongoose from 'mongoose';
import { Tenancy } from '../models/Tenancy.js';
import { Tenant } from '../models/Tenant.js';
import { House } from '../models/House.js';
import { Errors } from '../utils/errors.js';
import { estateFilterClause } from '../utils/estateFilter.js';
import { supportsMongoTransactions } from '../config/database.js';

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

  async open({ clientId, estateId, houseId, tenantId, startAt, actorUserId = null }, { session: outer } = {}) {
    requireTransactions();
    const start = startAt ? new Date(startAt) : new Date();
    const run = async (session) => {
      const house = await House.findOne({ _id: houseId, clientId }).session(session);
      if (!house) throw Errors.HouseNotFound();
      if (house.tenantId && !house.tenantId.equals(tenantId)) {
        throw Errors.Conflict('House already has a different active tenant');
      }
      const existing = await Tenancy.findOne({ houseId, status: 'ACTIVE' }).session(session);
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
