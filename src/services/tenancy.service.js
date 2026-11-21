// src/services/tenancy.service.js
import mongoose from 'mongoose';
import { MpesaCollectionReference } from '../models/MpesaCollectionReference.js';
import { Tenancy } from '../models/Tenancy.js';
import { Tenant } from '../models/Tenant.js';
import { House } from '../models/House.js';
import { Errors } from '../utils/errors.js';
import { estateFilterClause } from '../utils/estateFilter.js';
import { supportsMongoTransactions } from '../config/database.js';
import { tenancyIneligibleReason, TENANCY_RESOLUTION } from '../utils/manualPaymentTenancy.js';
import { eligibleTenancyFilter } from '../utils/tenancyEligibility.js';

const oid = (v) => new mongoose.Types.ObjectId(String(v));

const escapeRegex = (v) => v.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const clampPage = (v) => Math.min(Math.max(Math.trunc(Number(v)) || 1, 1), 10000);
const clampLimit = (v, dflt) => Math.min(Math.max(Math.trunc(Number(v)) || dflt, 1), 50);

async function tenancyPage({ clientId, house, extra = null, term = '', pageNo, pageSize }) {
  const clientOid = oid(clientId);
  const match = { clientId: clientOid, houseId: oid(house._id), estateId: oid(house.estateId), status: { $in: ['ACTIVE', 'CLOSED'] }, ...(extra || {}) };
  const tenantMatch = { $expr: { $and: [{ $eq: ['$_id', '$$tid'] }, { $eq: ['$clientId', clientOid] }] } };
  if (term) tenantMatch.name = { $regex: escapeRegex(term), $options: 'i' };
  const lookup = { $lookup: { from: Tenant.collection.name, let: { tid: '$tenantId' }, pipeline: [{ $match: tenantMatch }, { $project: { name: 1 } }], as: '_tenant' } };
  const pageStages = [
    { $sort: { startAt: -1, _id: -1 } },
    { $skip: (pageNo - 1) * pageSize },
    { $limit: pageSize },
  ];
  const pipeline = term
    ? [{ $match: match }, lookup, { $match: { '_tenant.0': { $exists: true } } }, {
      $facet: { rows: [...pageStages, { $addFields: { tenantName: { $arrayElemAt: ['$_tenant.name', 0] } } }, { $project: { _tenant: 0 } }], total: [{ $count: 'n' }] },
    }]
    : [{ $match: match }, {
      $facet: { rows: [...pageStages, lookup, { $addFields: { tenantName: { $arrayElemAt: ['$_tenant.name', 0] } } }, { $project: { _tenant: 0 } }], total: [{ $count: 'n' }] },
    }];
  const [facet] = await Tenancy.aggregate(pipeline);
  return { rows: facet?.rows || [], total: facet?.total?.[0]?.n || 0 };
}

async function resolveEligible(base, period, { tenantId = null, session = null } = {}) {
  const elig = eligibleTenancyFilter(period);
  if (!elig) return { status: TENANCY_RESOLUTION.NONE, tenancy: null };
  const rows = await Tenancy.find({ ...base, ...elig, ...(tenantId ? { tenantId } : {}) })
    .sort({ startAt: -1, _id: -1 }).limit(2).session(session || null).lean();
  if (rows.length === 1) return { status: TENANCY_RESOLUTION.UNIQUE, tenancy: rows[0] };
  if (rows.length === 0) return { status: TENANCY_RESOLUTION.NONE, tenancy: null };
  return { status: TENANCY_RESOLUTION.AMBIGUOUS, tenancy: null };
}

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
  return Number.isFinite(end) && t < end;
}

async function retireTenancyReferences(clientId, tenancyId, session) {
  await MpesaCollectionReference.updateMany(
    { clientId, tenancyId, status: 'ACTIVE' },
    { $set: { status: 'RETIRED', retiredAt: new Date(), retiredReason: 'TENANCY_CLOSED' } },
    { session },
  );
}

/** Find all tenancies covering an instant (status ACTIVE|CLOSED, startAt <= at < endAt). */
async function coveringAt(clientId, houseId, eventTime, { session = null, tenantId = null } = {}) {
  const at = new Date(eventTime);
  const filter = {
    clientId,
    houseId,
    status: { $in: ['ACTIVE', 'CLOSED'] },
    startAt: { $lte: at },
    $or: [{ endAt: null }, { endAt: { $gt: at } }],
  };
  if (tenantId) filter.tenantId = tenantId;
  return Tenancy.find(filter).sort({ startAt: -1, _id: -1 }).session(session || null).lean();
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
    const candidates = await coveringAt(clientId, houseId, eventTime, { session });
    if (candidates.length === 1) return candidates[0];
    return null;
  },

  /**
   * Occupancy check for the simplified Record Payment form.
   * Ordinary destinations are active, currently occupied houses with exactly one
   * canonical ACTIVE tenancy whose tenantId agrees with House.tenantId.
   * For a backdated paymentDate, also require a unique historical covering tenancy.
   */
  async resolveOccupancyForManualPayment(clientId, house, paymentDate = new Date()) {
    if (house.isActive === false) {
      return { ok: false, reason: 'This house is inactive and cannot receive a payment.', tenancy: null };
    }
    if (house.status === 'vacant' || !house.tenantId) {
      return { ok: false, reason: 'This house is vacant. Only occupied houses can receive ordinary payments.', tenancy: null };
    }

    const activeRows = await Tenancy.find({
      clientId,
      houseId: house._id,
      estateId: house.estateId,
      status: 'ACTIVE',
    }).limit(2).lean();

    if (activeRows.length === 0) {
      return {
        ok: false,
        reason: 'No active tenancy is recorded for this house. House status and tenancy data disagree.',
        tenancy: null,
      };
    }
    if (activeRows.length > 1) {
      return {
        ok: false,
        reason: 'Multiple active tenancies exist for this house. Resolve occupancy before recording a payment.',
        tenancy: null,
      };
    }

    const active = activeRows[0];
    if (String(active.tenantId) !== String(house.tenantId)) {
      return {
        ok: false,
        reason: 'House occupant and active tenancy tenant do not match. Resolve occupancy before recording a payment.',
        tenancy: null,
      };
    }

    const at = new Date(paymentDate);
    const covering = await coveringAt(clientId, house._id, at);
    if (covering.length === 0) {
      return {
        ok: false,
        reason: 'No tenancy covered this house on the selected payment date. A backdated payment cannot be attributed.',
        tenancy: null,
      };
    }
    if (covering.length > 1) {
      return {
        ok: false,
        reason: 'More than one tenancy covered this house on the selected payment date. Ownership is ambiguous.',
        tenancy: null,
      };
    }

    const coveringTenancy = covering[0];
    if (String(coveringTenancy.estateId) !== String(house.estateId)) {
      return {
        ok: false,
        reason: 'Tenancy estate does not match the house estate.',
        tenancy: null,
      };
    }

    return { ok: true, reason: null, tenancy: coveringTenancy };
  },

  /**
   * Resolve the single Tenancy a manual payment belongs to.
   * Ordinary path: paymentDate → unique covering tenancy (fails closed).
   * Explicit tenancyId / period remain for edge-case callers.
   */
  async resolveForManualPayment(clientId, house, { period = null, paymentDate = null, tenancyId = null, tenantId = null } = {}, { session } = {}) {
    const base = { clientId, houseId: house._id, estateId: house.estateId, status: { $in: ['ACTIVE', 'CLOSED'] } };

    if (tenancyId) {
      const t = await Tenancy.findOne({ ...base, _id: tenancyId }).session(session || null).lean();
      if (!t) throw Errors.InvalidRequest('Selected tenancy does not belong to this house');
      if (tenantId && String(t.tenantId) !== String(tenantId)) {
        throw Errors.InvalidRequest('Selected tenancy belongs to a different tenant');
      }
      if (period) {
        const reason = tenancyIneligibleReason(t, period);
        if (reason) throw Errors.InvalidRequest(`Selected tenancy cannot take a payment for ${period}: ${reason}`);
      }
      if (paymentDate && !tenancyContains(t, paymentDate)) {
        throw Errors.InvalidRequest('Selected tenancy does not cover the payment date');
      }
      return t;
    }

    // Ordinary path: resolve by payment date (preferred).
    if (paymentDate) {
      if (house.isActive === false) {
        throw Errors.InvalidRequest('This house is inactive and cannot receive a payment');
      }

      const activeCount = await Tenancy.countDocuments({
        clientId,
        houseId: house._id,
        estateId: house.estateId,
        status: 'ACTIVE',
      }).session(session || null);

      // For a current-date payment on a vacant house, refuse.
      // Backdated payments may target a CLOSED historical tenancy even if the house is vacant today,
      // but only when exactly one covering tenancy exists for that date.
      const at = new Date(paymentDate);
      const covering = await coveringAt(clientId, house._id, at, { session, tenantId });

      if (covering.length === 0) {
        if (house.status === 'vacant' || !house.tenantId) {
          throw Errors.InvalidRequest('This house is vacant and has no tenancy covering the payment date');
        }
        throw Errors.InvalidRequest('No unique tenancy covers the payment date for this house');
      }
      if (covering.length > 1) {
        throw Errors.Conflict(
          'More than one tenancy covered this house on the payment date; ownership is ambiguous'
        );
      }

      const t = covering[0];
      if (String(t.estateId) !== String(house.estateId)) {
        throw Errors.InvalidRequest('Tenancy estate does not match the house estate');
      }
      if (tenantId && String(t.tenantId) !== String(tenantId)) {
        throw Errors.InvalidRequest('tenantId does not match the tenancy covering the payment date');
      }

      // When recording for "today" on an occupied house, require a consistent active tenancy.
      if (t.status === 'ACTIVE') {
        if (activeCount > 1) {
          throw Errors.Conflict('Multiple active tenancies exist for this house');
        }
        if (house.tenantId && String(house.tenantId) !== String(t.tenantId)) {
          throw Errors.InvalidRequest(
            'House occupant and active tenancy tenant do not match'
          );
        }
      }

      return t;
    }

    // Legacy period-based path (edge cases).
    if (period) {
      const r = await resolveEligible(base, period, { tenantId, session });
      if (r.status === TENANCY_RESOLUTION.UNIQUE) return r.tenancy;
      if (r.status === TENANCY_RESOLUTION.AMBIGUOUS) {
        throw Errors.Conflict(`More than one tenancy covers ${period} for this house; choose which tenancy this payment is for`);
      }
      if (tenantId && (await resolveEligible(base, period, { session })).status !== TENANCY_RESOLUTION.NONE) {
        throw Errors.InvalidRequest('tenantId does not match any tenancy covering this period for this house');
      }
      throw Errors.InvalidRequest(`No tenancy fully covers ${period} for this house; a payment cannot be attributed to a tenant`);
    }

    throw Errors.InvalidRequest('paymentDate is required to resolve payment ownership');
  },

  async manualPaymentOptions(clientId, house, period, {
    page = 1, limit = 20, search = '', eligiblePage = 1, eligibleLimit = 10, eligibleSearch = '',
  } = {}) {
    const base = { clientId, houseId: house._id, estateId: house.estateId, status: { $in: ['ACTIVE', 'CLOSED'] } };
    const elig = eligibleTenancyFilter(period);

    const r = await resolveEligible(base, period);

    const ePage = clampPage(eligiblePage);
    const eSize = clampLimit(eligibleLimit, 10);
    const eTerm = String(eligibleSearch || '').trim().slice(0, 80);
    const [eligibleTotal, eligiblePageResult] = await Promise.all([
      elig ? Tenancy.countDocuments({ ...base, ...elig }) : 0,
      elig ? tenancyPage({ clientId, house, extra: elig, term: eTerm, pageNo: ePage, pageSize: eSize }) : { rows: [], total: 0 },
    ]);

    const hPage = clampPage(page);
    const hSize = clampLimit(limit, 20);
    const hTerm = String(search || '').trim().slice(0, 80);
    const history = await tenancyPage({ clientId, house, term: hTerm, pageNo: hPage, pageSize: hSize });

    const toOption = (t) => {
      const reason = tenancyIneligibleReason(t, period);
      return {
        tenancyId: String(t._id),
        tenantName: t.tenantName || 'Unknown tenant',
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
      eligibleTotal,
      eligibleSelection: {
        items: eligiblePageResult.rows.map(toOption),
        page: ePage,
        limit: eSize,
        total: eligiblePageResult.total,
        hasMore: ePage * eSize < eligiblePageResult.total,
        search: eTerm,
      },
      options: history.rows.map(toOption),
      page: hPage,
      limit: hSize,
      total: history.total,
      hasMore: hPage * hSize < history.total,
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
