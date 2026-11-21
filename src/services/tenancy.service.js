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

/**
 * One database-side page of a house's tenancies, optionally restricted by an extra predicate
 * (the eligibility filter) and by tenant name. Everything happens in MongoDB: the tenant join is a
 * $lookup scoped to the client, the name filter runs inside that join, and sort/skip/limit/count
 * run in one $facet. Only `pageSize` rows ever reach JavaScript. The exact `total` is computed by
 * the same pipeline, so it can never disagree with the rows.
 */
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
  // With a name search the join must run before paging (it decides membership); without one it
  // runs only for the rows of the current page, so the join cost is bounded by the page size.
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

/**
 * Resolve NONE / UNIQUE / AMBIGUOUS over the COMPLETE eligible set in the database.
 * Two rows are enough to distinguish the three outcomes, so nothing is truncated and nothing
 * unbounded is loaded: limit(2) is a decision bound, not a candidate cap.
 */
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
    const r = await resolveEligible(base, period, { tenantId, session });
    if (r.status === TENANCY_RESOLUTION.UNIQUE) return r.tenancy;
    if (r.status === TENANCY_RESOLUTION.AMBIGUOUS) {
      throw Errors.Conflict(`More than one tenancy covers ${period} for this house; choose which tenancy this payment is for`);
    }
    if (tenantId && (await resolveEligible(base, period, { session })).status !== TENANCY_RESOLUTION.NONE) {
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
  async manualPaymentOptions(clientId, house, period, {
    page = 1, limit = 20, search = '', eligiblePage = 1, eligibleLimit = 10, eligibleSearch = '',
  } = {}) {
    const base = { clientId, houseId: house._id, estateId: house.estateId, status: { $in: ['ACTIVE', 'CLOSED'] } };
    const elig = eligibleTenancyFilter(period);

    // Decision: NONE / UNIQUE / AMBIGUOUS. limit(2) is a decision bound, never a candidate cap.
    const r = await resolveEligible(base, period);

    // SELECTABLE list: only tenancies that satisfy the exact eligibility predicate, searched and
    // paginated in MongoDB. `total` follows the search; `eligibleTotal` is the unfiltered exact count.
    const ePage = clampPage(eligiblePage);
    const eSize = clampLimit(eligibleLimit, 10);
    const eTerm = String(eligibleSearch || '').trim().slice(0, 80);
    const [eligibleTotal, eligiblePageResult] = await Promise.all([
      elig ? Tenancy.countDocuments({ ...base, ...elig }) : 0,
      elig ? tenancyPage({ clientId, house, extra: elig, term: eTerm, pageNo: ePage, pageSize: eSize }) : { rows: [], total: 0 },
    ]);

    // INFORMATIONAL history (explains a NONE result). Rows carry coversPeriod/reason but this list
    // is never a selection source; the selectable list above is separate.
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
      // Informational history (legacy fields keep their meaning: NOT selectable).
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
