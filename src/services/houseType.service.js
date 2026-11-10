// src/services/houseType.service.js
// Estate-scoped HouseType catalog with immutable billing-plan history.
import mongoose from 'mongoose';
import { HouseType, assertUniquePlanLines } from '../models/HouseType.js';
import { Estate } from '../models/Estate.js';
import { HouseTypePlanVersion } from '../models/HouseTypePlanVersion.js';
import { appendHouseTypePlanVersion, validateBillingPeriod } from './houseTypePlanVersion.service.js';
import { House } from '../models/House.js';
import { Tenant } from '../models/Tenant.js';
import { Tenancy } from '../models/Tenancy.js';
import { RentCharge } from '../models/RentCharge.js';
import { Errors } from '../utils/errors.js';
import { dateUtil } from '../utils/date.js';
import { estateFilterClause } from '../utils/estateFilter.js';
import { assertHouseTypeIndexesAligned } from '../utils/houseTypeIndexReadiness.js';

function normalizeName(name) {
  return String(name || '').trim();
}

function normalizeBillingLines(raw, defaultRentCents, defaultDueDay) {
  if (!Array.isArray(raw)) {
    return defaultRentCents > 0
      ? [{ chargeType: 'RENT', description: 'Rent', amountCents: defaultRentCents, dueDay: defaultDueDay }]
      : [];
  }
  const allowed = new Set(['RENT', 'WATER', 'ELECTRICITY', 'OTHER']);
  const seenOther = new Set();
  const lines = [];
  for (const line of raw) {
    const chargeType = String(line.chargeType || '').toUpperCase();
    if (!allowed.has(chargeType)) {
      throw Errors.InvalidRequest(`Invalid chargeType: ${line.chargeType}`);
    }
    const amountCents = Number(line.amountCents);
    if (!Number.isSafeInteger(amountCents) || amountCents < 0) {
      throw Errors.InvalidRequest('Billing line amountCents must be a non-negative safe integer');
    }
    if (amountCents === 0) continue;
    let description = String(line.description || chargeType).trim();
    if (!description) throw Errors.InvalidRequest('Billing line description/label is required');
    if (chargeType === 'OTHER') {
      const key = description.toLowerCase();
      if (seenOther.has(key)) throw Errors.InvalidRequest(`Duplicate custom billing line: ${description}`);
      seenOther.add(key);
    }
    let dueDay = line.dueDay != null ? Number(line.dueDay) : defaultDueDay;
    if (dueDay != null) {
      dueDay = Math.min(31, Math.max(1, Math.trunc(dueDay)));
    }
    lines.push({ chargeType, description, amountCents, dueDay });
  }
  return lines;
}



function nextBillingPeriod(period) {
  validateBillingPeriod(period);
  const [year, month] = period.split('-').map(Number);
  const next = new Date(Date.UTC(year, month, 1));
  return `${next.getUTCFullYear()}-${String(next.getUTCMonth() + 1).padStart(2, '0')}`;
}

function planLinesFromType(type) {
  // defaultBilling is the sole canonical plan. An empty array is an explicit
  // zero-line plan, never a request to resurrect the legacy rent mirror.
  return Array.isArray(type.defaultBilling) ? type.defaultBilling : [];
}

export const houseTypeService = {
  async list(clientId, { estateId = null, estateFilter = null, includeInactive = false } = {}) {
    const filter = { clientId, ...estateFilterClause(estateFilter) };
    if (estateId) filter.estateId = estateId;
    if (!includeInactive) filter.isActive = true;
    const types = await HouseType.find(filter).sort({ name: 1 }).lean();
    const counts = await House.aggregate([
      { $match: { clientId, ...(estateId ? { estateId } : {}), ...estateFilterClause(estateFilter), houseTypeId: { $ne: null } } },
      { $group: { _id: '$houseTypeId', count: { $sum: 1 } } },
    ]);
    const countMap = new Map(counts.map((c) => [String(c._id), c.count]));
    return types.map((t) => ({
      ...t,
      houseCount: countMap.get(String(t._id)) || 0,
    }));
  },

  async get(clientId, id, { estateId = null, estateFilter = null } = {}) {
    const filter = { _id: id, clientId, ...estateFilterClause(estateFilter) };
    if (estateId) filter.estateId = estateId;
    const t = await HouseType.findOne(filter).lean();
    if (!t) throw Errors.HouseTypeNotFound();
    const [houseCount, planVersions] = await Promise.all([
      House.countDocuments({ clientId, estateId: t.estateId, houseTypeId: id }),
      HouseTypePlanVersion.find({ clientId, estateId: t.estateId, houseTypeId: id }).sort({ effectiveFromPeriod: 1, version: 1 }).lean(),
    ]);
    return { ...t, houseCount, planVersions };
  },

  async create(clientId, data) {
    await assertHouseTypeIndexesAligned();
    const name = normalizeName(data.name);
    if (!name) throw Errors.InvalidRequest('Name is required');
    if (!data.estateId) throw Errors.InvalidRequest('estateId is required for an Estate-owned HouseType');
    const estate = await Estate.findOne({ _id: data.estateId, clientId }).lean();
    if (!estate) throw Errors.EstateNotFound('Estate not found for this client');

    const defaultRentCents = Number.isSafeInteger(data.defaultRentCents)
      ? Math.max(0, data.defaultRentCents) : 0;
    const defaultBilling = normalizeBillingLines(data.defaultBilling, defaultRentCents, data.defaultDueDay);
    assertUniquePlanLines(defaultBilling);
    const effectiveFromPeriod = validateBillingPeriod(data.effectiveFromPeriod || dateUtil.currentPeriod());

    const session = await mongoose.startSession();
    let createdType;
    try {
      await session.withTransaction(async () => {
        const existing = await HouseType.findOne({ clientId, estateId: data.estateId, name })
          .collation({ locale: 'en', strength: 2 }).session(session);
        if (existing) throw Errors.Conflict('A house type with this name already exists in this estate');

        const [type] = await HouseType.create([{
          clientId, estateId: data.estateId, name,
          description: data.description || '',
          defaultRentCents,
          defaultDueDay: data.defaultDueDay,
          defaultBilling,
          planVersion: 1,
          isActive: data.isActive !== false,
        }], { session });

        await appendHouseTypePlanVersion({
          clientId, estateId: data.estateId, houseTypeId: type._id,
          effectiveFromPeriod,
          lines: planLinesFromType(type),
          createdBy: data.createdBy || null,
          changeReason: 'Initial HouseType billing plan',
          session,
        });
        createdType = type;
      });
    } finally {
      await session.endSession();
    }
    return createdType;
  },

  async update(clientId, id, data) {
    await assertHouseTypeIndexesAligned();
    const session = await mongoose.startSession();
    let updatedType;
    try {
      await session.withTransaction(async () => {
        const type = await HouseType.findOne({ _id: id, clientId }).session(session);
        if (!type) throw Errors.HouseTypeNotFound();
        if (data.estateId !== undefined && String(data.estateId) !== String(type.estateId)) {
          throw Errors.InvalidRequest('HouseType ownership cannot move between Estates; create a new HouseType instead.');
        }
        if (data.name !== undefined) {
          const name = normalizeName(data.name);
          if (!name) throw Errors.InvalidRequest('Name is required');
          const clash = await HouseType.findOne({ clientId, estateId: type.estateId, _id: { $ne: id }, name })
            .collation({ locale: 'en', strength: 2 }).session(session);
          if (clash) throw Errors.Conflict('A house type with this name already exists in this estate');
          type.name = name;
        }
        if (data.description !== undefined) type.description = data.description;
        if (data.defaultRentCents !== undefined) {
          if (!Number.isSafeInteger(Number(data.defaultRentCents)) || Number(data.defaultRentCents) < 0) {
            throw Errors.InvalidRequest('defaultRentCents must be a non-negative safe integer');
          }
          type.defaultRentCents = Number(data.defaultRentCents);
        }
        if (data.defaultDueDay !== undefined) type.defaultDueDay = data.defaultDueDay;

        if (data.defaultBilling === undefined
          && (data.defaultRentCents !== undefined || data.defaultDueDay !== undefined)) {
          const lines = (type.defaultBilling || []).map((line) =>
            typeof line.toObject === 'function' ? line.toObject() : { ...line }
          );
          const rentIndex = lines.findIndex((line) =>
            line.chargeType === 'RENT' && String(line.description || '').trim().toLowerCase() === 'rent'
          );
          if (type.defaultRentCents <= 0 && rentIndex >= 0) {
            lines.splice(rentIndex, 1);
          } else if (type.defaultRentCents > 0 && rentIndex >= 0) {
            lines[rentIndex].amountCents = type.defaultRentCents;
            if (data.defaultDueDay !== undefined) lines[rentIndex].dueDay = type.defaultDueDay;
          } else if (data.defaultRentCents !== undefined && type.defaultRentCents > 0) {
            lines.push({ chargeType: 'RENT', description: 'Rent', amountCents: type.defaultRentCents, dueDay: type.defaultDueDay });
          }
          type.defaultBilling = normalizeBillingLines(lines, 0, type.defaultDueDay);
          assertUniquePlanLines(type.defaultBilling);
        }

        let planDirty = data.defaultRentCents !== undefined || data.defaultDueDay !== undefined;
        if (data.defaultBilling !== undefined) {
          type.defaultBilling = normalizeBillingLines(data.defaultBilling, type.defaultRentCents, type.defaultDueDay);
          assertUniquePlanLines(type.defaultBilling);
          planDirty = true;
        }
        if (typeof data.isActive === 'boolean') type.isActive = data.isActive;

        if (planDirty) {
          const effectiveFromPeriod = validateBillingPeriod(
            data.effectiveFromPeriod || nextBillingPeriod(dateUtil.currentPeriod())
          );
          const nextVersion = await appendHouseTypePlanVersion({
            clientId, estateId: type.estateId, houseTypeId: type._id,
            effectiveFromPeriod,
            lines: planLinesFromType(type),
            createdBy: data.updatedBy || null,
            changeReason: data.changeReason || 'HouseType billing plan changed',
            session,
          });
          type.planVersion = nextVersion.version;
        } else if (data.effectiveFromPeriod !== undefined) {
          throw Errors.InvalidRequest('effectiveFromPeriod is only valid when changing billing plan terms');
        }
        await type.save({ session });
        updatedType = type;
      });
    } finally {
      await session.endSession();
    }
    return updatedType;
  },

  async deactivate(clientId, id) {
    return this.update(clientId, id, { isActive: false });
  },


  /**
   * HouseType management workspace: houses of this type + occupancy + period financials.
   * Optional estateId narrows within client; estateFilter enforces STAFF isolation.
   */
  async workspace(clientId, id, { estateId = null, estateFilter = null } = {}) {
    const type = await HouseType.findOne({
      _id: id, clientId, ...estateFilterClause(estateFilter),
    }).lean();
    if (!type) throw Errors.HouseTypeNotFound();
    if (estateId && String(estateId) !== String(type.estateId)) throw Errors.HouseTypeNotFound();

    const houses = await House.find({
      clientId, estateId: type.estateId, houseTypeId: id, isActive: true,
      ...estateFilterClause(estateFilter),
    }).lean();
    const houseIds = houses.map((house) => house._id);
    const period = dateUtil.currentPeriod();
    const now = new Date();

    const tenancies = houseIds.length
      ? await Tenancy.find({ clientId, estateId: type.estateId, houseId: { $in: houseIds } }).lean()
      : [];
    const tenancyById = new Map(tenancies.map((tenancy) => [String(tenancy._id), tenancy]));
    const activeByHouse = new Map();
    for (const tenancy of tenancies) {
      const activeNow = tenancy.status === 'ACTIVE'
        && (!tenancy.startAt || tenancy.startAt <= now)
        && (!tenancy.endAt || tenancy.endAt > now);
      if (!activeNow) continue;
      const key = String(tenancy.houseId);
      if (!activeByHouse.has(key)) activeByHouse.set(key, []);
      activeByHouse.get(key).push(tenancy);
    }

    const currentTenancyIds = new Set(
      [...activeByHouse.values()].filter((rows) => rows.length === 1).map((rows) => String(rows[0]._id))
    );
    const currentTenantIds = [...new Set(
      [...activeByHouse.values()].filter((rows) => rows.length === 1)
        .map((rows) => rows[0].tenantId).filter(Boolean).map(String)
    )];
    const tenants = currentTenantIds.length
      ? await Tenant.find({ clientId, _id: { $in: currentTenantIds } }).lean()
      : [];
    const tenantById = new Map(tenants.map((tenant) => [String(tenant._id), tenant]));

    const [periodCharges, openCharges] = houseIds.length
      ? await Promise.all([
          RentCharge.find({ clientId, estateId: type.estateId, houseId: { $in: houseIds }, period }).lean(),
          RentCharge.find({
            clientId, estateId: type.estateId, houseId: { $in: houseIds },
            status: { $in: ['UNPAID', 'PARTIAL', 'OVERPAID'] },
          }).lean(),
        ])
      : [[], []];

    const categoryOf = (charge) => {
      if (!charge.tenancyId) return 'unattributed';
      const tenancyKey = String(charge.tenancyId);
      if (!tenancyById.has(tenancyKey)) return 'orphaned';
      return currentTenancyIds.has(tenancyKey) ? 'current' : 'historical';
    };
    const summarize = (category) => {
      const periodRows = periodCharges.filter((charge) => categoryOf(charge) === category);
      const openRows = openCharges.filter((charge) => categoryOf(charge) === category);
      return {
        billedCents: periodRows.reduce((sum, charge) => sum + (charge.amountDueCents || 0), 0),
        collectedCents: periodRows.reduce((sum, charge) => sum + (charge.amountPaidCents || 0), 0),
        outstandingCents: openRows.reduce((sum, charge) => sum + Math.max(charge.balanceCents || 0, 0), 0),
        overpaidCreditCents: openRows.reduce((sum, charge) => sum + Math.max(-(charge.balanceCents || 0), 0), 0),
        chargeCount: periodRows.length,
      };
    };
    const currentFinancials = summarize('current');
    const historicalFinancials = summarize('historical');
    const unattributedFinancials = summarize('unattributed');
    const orphanedFinancials = summarize('orphaned');
    const allHouseHistory = {
      billedCents: periodCharges.reduce((sum, charge) => sum + (charge.amountDueCents || 0), 0),
      collectedCents: periodCharges.reduce((sum, charge) => sum + (charge.amountPaidCents || 0), 0),
      outstandingCents: openCharges.reduce((sum, charge) => sum + Math.max(charge.balanceCents || 0, 0), 0),
      overpaidCreditCents: openCharges.reduce((sum, charge) => sum + Math.max(-(charge.balanceCents || 0), 0), 0),
    };

    let occupied = 0;
    let vacant = 0;
    for (const house of houses) {
      if (house.status === 'occupied') occupied += 1;
      else vacant += 1;
    }
    const houseRows = houses.map((house) => {
      const active = activeByHouse.get(String(house._id)) || [];
      const currentTenancy = active.length === 1 ? active[0] : null;
      const houseCategory = (charge) => String(charge.houseId) === String(house._id);
      const byHouse = (category) => {
        const pRows = periodCharges.filter((charge) => houseCategory(charge) && categoryOf(charge) === category);
        const oRows = openCharges.filter((charge) => houseCategory(charge) && categoryOf(charge) === category);
        return {
          billedCents: pRows.reduce((sum, charge) => sum + (charge.amountDueCents || 0), 0),
          collectedCents: pRows.reduce((sum, charge) => sum + (charge.amountPaidCents || 0), 0),
          outstandingCents: oRows.reduce((sum, charge) => sum + Math.max(charge.balanceCents || 0, 0), 0),
          overpaidCreditCents: oRows.reduce((sum, charge) => sum + Math.max(-(charge.balanceCents || 0), 0), 0),
        };
      };
      return {
        _id: house._id,
        houseNumber: house.houseNumber,
        estateId: house.estateId,
        status: house.status,
        billingSource: house.billingSource || 'LEGACY_UNCLASSIFIED',
        currentTenancy: currentTenancy ? {
          _id: currentTenancy._id,
          tenant: currentTenancy.tenantId ? tenantById.get(String(currentTenancy.tenantId)) || null : null,
          financials: byHouse('current'),
        } : null,
        currentOccupancyConflict: active.length > 1,
        historicalTenancyFinancials: byHouse('historical'),
        unattributedLegacyFinancials: byHouse('unattributed'),
        orphanedTenancyFinancials: byHouse('orphaned'),
      };
    });

    const currentTenancyCollectionRate = currentFinancials.billedCents > 0
      ? Math.round((currentFinancials.collectedCents / currentFinancials.billedCents) * 1000) / 10
      : null;
    const allHouseHistoryCollectionRate = allHouseHistory.billedCents > 0
      ? Math.round((allHouseHistory.collectedCents / allHouseHistory.billedCents) * 1000) / 10
      : null;
    return {
      houseType: type,
      period,
      metrics: {
        houseCount: houses.length,
        occupiedHouses: occupied,
        vacantHouses: vacant,
        tenantCount: currentTenancyIds.size,
        currentTenancy: currentFinancials,
        historicalTenancies: historicalFinancials,
        unattributedLegacy: unattributedFinancials,
        orphanedTenancy: orphanedFinancials,
        // Backward-compatible totals are explicitly labeled all-house history,
        // never the current occupant's liability.
        allHouseHistory,
        billedCents: allHouseHistory.billedCents,
        collectedCents: allHouseHistory.collectedCents,
        outstandingCents: allHouseHistory.outstandingCents,
        openOutstandingCents: allHouseHistory.outstandingCents,
        collectionRatePercent: allHouseHistoryCollectionRate,
        currentTenancyCollectionRatePercent: currentTenancyCollectionRate,
        ambiguousCurrentOccupancyHouses: [...activeByHouse.values()].filter((rows) => rows.length > 1).length,
      },
      houses: houseRows,
    };
  },

  /** Resolve an active HouseType owned by the same client AND Estate. */
  async assertOwned(clientId, estateId, houseTypeId) {
    if (!houseTypeId) return null;
    const t = await HouseType.findOne({ _id: houseTypeId, clientId, estateId, isActive: true });
    if (!t) throw Errors.HouseTypeNotFound('House type not found for this Estate');
    return t;
  },
};
