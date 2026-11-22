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

/**
 * Tenancies that overlap a Nairobi calendar day window [dayStart, dayEnd].
 * Used for date-only payment attribution. Multiple overlapping rows are always
 * ambiguous for a date-only submission (including same-tenant overlaps).
 */
async function coveringNairobiDay(clientId, houseId, dayStart, dayEnd, { session = null } = {}) {
  return Tenancy.find({
    clientId,
    houseId,
    status: { $in: ['ACTIVE', 'CLOSED'] },
    startAt: { $lte: dayEnd },
    $or: [{ endAt: null }, { endAt: { $gt: dayStart } }],
  }).sort({ startAt: -1, _id: -1 }).session(session || null).lean();
}

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
   * Ordinary manual-payment occupancy.
   * 1) House must currently be eligible: active, occupied, exactly one ACTIVE
   *    tenancy matching House.tenantId, tenant in same client+estate.
   * 2) paymentDate (Nairobi day) must resolve to exactly one historical tenancy
   *    covering that calendar day (may be CLOSED / former occupant).
   * Multiple tenancy rows covering the same day are always rejected, even when
   * they share the same tenantId. Noon is never used as a tie-breaker.
   *
   * @param {object} nairobiDay - from dateUtil.parseNairobiDateOnly, or a Date (legacy).
   */
  async resolveOccupancyForManualPayment(clientId, house, nairobiDay, { session } = {}) {
    if (house.isActive === false) {
      return { ok: false, reason: 'This house is inactive and cannot receive a payment.', tenancy: null };
    }
    if (house.status !== 'occupied' || !house.tenantId) {
      return { ok: false, reason: 'This house is vacant. Only occupied houses can receive ordinary payments.', tenancy: null };
    }

    const activeRows = await Tenancy.find({
      clientId,
      houseId: house._id,
      estateId: house.estateId,
      status: 'ACTIVE',
    }).limit(2).session(session || null).lean();

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

    const tenant = await Tenant.findOne({
      _id: active.tenantId,
      clientId,
      estateId: house.estateId,
    }).session(session || null).lean();
    if (!tenant) {
      return {
        ok: false,
        reason: 'Active tenancy tenant is not in this client and estate.',
        tenancy: null,
      };
    }

    // Nairobi calendar-day coverage for the payment date.
    let dayStart;
    let dayEnd;
    if (nairobiDay && nairobiDay.start && nairobiDay.end) {
      dayStart = nairobiDay.start;
      dayEnd = nairobiDay.end;
    } else {
      const at = new Date(nairobiDay);
      dayStart = at;
      dayEnd = at;
    }

    const covering = await coveringNairobiDay(clientId, house._id, dayStart, dayEnd, { session });
    if (covering.length === 0) {
      return {
        ok: false,
        reason: 'No tenancy covered this house on the selected payment date. A backdated payment cannot be attributed.',
        tenancy: null,
      };
    }

    // Date-only payment cannot disambiguate multiple tenancy rows covering the same day,
    // even when they share the same tenantId. Never use noon as a tie-breaker.
    if (covering.length > 1) {
      return {
        ok: false,
        reason: 'More than one tenancy record covers the selected payment date for this house. Ownership is ambiguous; a time of day is not collected.',
        tenancy: null,
      };
    }

    const chosen = covering[0];
    if (String(chosen.estateId) !== String(house.estateId)) {
      return {
        ok: false,
        reason: 'Tenancy estate does not match the house estate.',
        tenancy: null,
      };
    }

    return { ok: true, reason: null, tenancy: chosen, activeTenancy: active };
  },

  /**
   * Explicit manual-payment ownership. The operator chose tenant, house and tenancy;
   * this only VALIDATES that those three ids, the client/estate and the Nairobi payment
   * day agree. It never substitutes another tenant (e.g. the house's current occupant).
   * Rejects (422) when:
   *   - the tenancy is not in this client/estate scope, or is not ACTIVE/CLOSED;
   *   - the tenancy belongs to a different house or tenant than supplied;
   *   - the tenant is not in the tenancy's client+estate;
   *   - the tenancy does not cover the payment day (start after it, or ended before it).
   * A CLOSED tenancy is valid for a backdated payment inside its own dates.
   *
   * @param {object} house   House doc already scoped to client + estate filter.
   * @param {object} nairobiDay from dateUtil.parseNairobiDateOnly ({start,end,...}).
   */
  async resolveExplicitForManualPayment(clientId, house, { tenantId, tenancyId }, nairobiDay, { session } = {}) {
    if (!tenantId || !tenancyId) {
      throw Errors.InvalidRequest('tenantId and tenancyId are required to record a payment');
    }
    // One generic message for every identity mismatch so ids cannot be probed.
    const mismatch = () => Errors.InvalidRequest('tenant, house and tenancy do not match one another in this estate');

    const tenancy = await Tenancy.findOne({
      _id: tenancyId, clientId, houseId: house._id, estateId: house.estateId,
    }).session(session || null).lean();
    if (!tenancy || String(tenancy.tenantId) !== String(tenantId)) throw mismatch();
    if (!['ACTIVE', 'CLOSED'].includes(tenancy.status)) {
      throw Errors.InvalidRequest('The selected tenancy is not valid for payments');
    }

    const tenant = await Tenant.findOne({
      _id: tenantId, clientId, estateId: tenancy.estateId,
    }).session(session || null).lean();
    if (!tenant) throw mismatch();

    const start = new Date(tenancy.startAt).getTime();
    const end = tenancy.endAt == null ? null : new Date(tenancy.endAt).getTime();
    const dayStart = nairobiDay.start.getTime();
    const dayEnd = nairobiDay.end.getTime();
    // Same overlap rule as coveringNairobiDay: starts on/before the day's end, ends after its start.
    const covers = Number.isFinite(start) && start <= dayEnd && (end === null || end > dayStart);
    if (!covers) {
      throw Errors.InvalidRequest('The selected tenancy did not cover the payment date');
    }
    return { tenancy, tenant };
  },

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

    if (paymentDate) {
      const r = await this.resolveOccupancyForManualPayment(clientId, house, paymentDate, { session });
      if (!r.ok) throw Errors.InvalidRequest(r.reason || 'Cannot resolve occupancy for payment date');
      if (tenantId && String(r.tenancy.tenantId) !== String(tenantId)) {
        throw Errors.InvalidRequest('tenantId does not match the tenancy covering the payment date');
      }
      return r.tenancy;
    }

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
            { _id: current.houseId, clientId, tenantId: tenant._id },
            { tenantId: null, status: 'vacant' },
            { session }
          );
        }
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
        newHouse.tenantId = tenant._id;
        newHouse.status = 'occupied';
        await newHouse.save({ session });
        await Tenant.updateOne(
          { _id: tenant._id, clientId },
          { houseId: newHouse._id, estateId: newHouse.estateId, status: 'active', moveInDate: now, moveOutDate: null },
          { session }
        );
      });
      return newTenancy;
    } finally {
      session.endSession();
    }
  },
};
