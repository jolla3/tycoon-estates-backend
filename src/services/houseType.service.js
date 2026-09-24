// src/services/houseType.service.js
// Client-scoped house type catalog. All queries require clientId from session.
import { HouseType } from '../models/HouseType.js';
import { House } from '../models/House.js';
import { Tenant } from '../models/Tenant.js';
import { RentCharge } from '../models/RentCharge.js';
import { Errors } from '../utils/errors.js';
import { dateUtil } from '../utils/date.js';
import { estateFilterClause } from '../utils/estateFilter.js';

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
    const amountCents = Math.max(0, Math.trunc(Number(line.amountCents) || 0));
    if (amountCents <= 0) continue;
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



export const houseTypeService = {
  async list(clientId, { includeInactive = false } = {}) {
    const filter = { clientId };
    if (!includeInactive) filter.isActive = true;
    const types = await HouseType.find(filter).sort({ name: 1 }).lean();
    const counts = await House.aggregate([
      { $match: { clientId, houseTypeId: { $ne: null } } },
      { $group: { _id: '$houseTypeId', count: { $sum: 1 } } },
    ]);
    const countMap = new Map(counts.map((c) => [String(c._id), c.count]));
    return types.map((t) => ({
      ...t,
      houseCount: countMap.get(String(t._id)) || 0,
    }));
  },

  async get(clientId, id) {
    const t = await HouseType.findOne({ _id: id, clientId }).lean();
    if (!t) throw Errors.HouseTypeNotFound();
    const houseCount = await House.countDocuments({ clientId, houseTypeId: id });
    return { ...t, houseCount };
  },

  async create(clientId, data) {
    const name = normalizeName(data.name);
    if (!name) throw Errors.InvalidRequest('Name is required');

    const existing = await HouseType.findOne({
      clientId,
      name: new RegExp(`^${name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`, 'i'),
    });
    if (existing) throw Errors.Conflict('A house type with this name already exists');

    const defaultRentCents = Number.isFinite(data.defaultRentCents)
      ? Math.max(0, Math.trunc(data.defaultRentCents))
      : 0;

    const defaultBilling = normalizeBillingLines(
      data.defaultBilling,
      defaultRentCents,
      data.defaultDueDay
    );

    return HouseType.create({
      clientId,
      name,
      description: data.description || '',
      defaultRentCents,
      defaultDueDay: data.defaultDueDay,
      defaultBilling,
      isActive: data.isActive !== false,
    });
  },

  async update(clientId, id, data) {
    const type = await HouseType.findOne({ _id: id, clientId });
    if (!type) throw Errors.HouseTypeNotFound();

    if (data.name !== undefined) {
      const name = normalizeName(data.name);
      if (!name) throw Errors.InvalidRequest('Name is required');
      const clash = await HouseType.findOne({
        clientId,
        _id: { $ne: id },
        name: new RegExp(`^${name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`, 'i'),
      });
      if (clash) throw Errors.Conflict('A house type with this name already exists');
      type.name = name;
    }
    if (data.description !== undefined) type.description = data.description;
    if (data.defaultRentCents !== undefined) {
      type.defaultRentCents = Math.max(0, Math.trunc(Number(data.defaultRentCents) || 0));
    }
    if (data.defaultDueDay !== undefined) type.defaultDueDay = data.defaultDueDay;
    if (data.defaultBilling !== undefined) {
      type.defaultBilling = normalizeBillingLines(
        data.defaultBilling,
        type.defaultRentCents,
        type.defaultDueDay
      );
    }
    if (typeof data.isActive === 'boolean') type.isActive = data.isActive;

    await type.save();
    return type;
  },

  async deactivate(clientId, id) {
    return this.update(clientId, id, { isActive: false });
  },


  /**
   * HouseType management workspace: houses of this type + occupancy + period financials.
   * Optional estateId narrows within client; estateFilter enforces STAFF isolation.
   */
  async workspace(clientId, id, { estateId = null, estateFilter = null } = {}) {
    const type = await HouseType.findOne({ _id: id, clientId }).lean();
    if (!type) throw Errors.HouseTypeNotFound();

    const houseFilter = {
      clientId,
      houseTypeId: id,
      isActive: true,
      ...estateFilterClause(estateFilter),
    };
    if (estateId) houseFilter.estateId = estateId;

    const houses = await House.find(houseFilter).lean();
    const houseIds = houses.map((h) => h._id);
    const period = dateUtil.currentPeriod();

    let occupied = 0;
    let vacant = 0;
    for (const h of houses) {
      if (h.status === 'occupied') occupied += 1;
      else vacant += 1;
    }

    const [tenants, charges, openCharges] = await Promise.all([
      houseIds.length
        ? Tenant.find({ clientId, houseId: { $in: houseIds }, status: 'active' }).lean()
        : [],
      houseIds.length
        ? RentCharge.find({ clientId, houseId: { $in: houseIds }, period }).lean()
        : [],
      houseIds.length
        ? RentCharge.find({
            clientId,
            houseId: { $in: houseIds },
            status: { $in: ['UNPAID', 'PARTIAL'] },
          }).lean()
        : [],
    ]);

    let billedCents = 0;
    let collectedCents = 0;
    let outstandingPeriodCents = 0;
    for (const c of charges) {
      billedCents += c.amountDueCents || 0;
      collectedCents += c.amountPaidCents || 0;
      outstandingPeriodCents += Math.max(c.balanceCents || 0, 0);
    }
    let openOutstandingCents = 0;
    for (const c of openCharges) openOutstandingCents += Math.max(c.balanceCents || 0, 0);

    const tenantByHouse = new Map(tenants.map((t) => [String(t.houseId), t]));
    const chargeByHouse = new Map();
    for (const c of charges) {
      const k = String(c.houseId);
      if (!chargeByHouse.has(k)) chargeByHouse.set(k, { billed: 0, paid: 0, out: 0 });
      const row = chargeByHouse.get(k);
      row.billed += c.amountDueCents || 0;
      row.paid += c.amountPaidCents || 0;
      row.out += Math.max(c.balanceCents || 0, 0);
    }

    const houseRows = houses.map((h) => {
      const t = tenantByHouse.get(String(h._id));
      const fin = chargeByHouse.get(String(h._id)) || { billed: 0, paid: 0, out: 0 };
      return {
        _id: h._id,
        houseNumber: h.houseNumber,
        estateId: h.estateId,
        status: h.status,
        monthlyRent: h.monthlyRent,
        tenant: t ? { _id: t._id, name: t.name, phone: t.phone, status: t.status } : null,
        periodBilledCents: fin.billed,
        periodPaidCents: fin.paid,
        periodOutstandingCents: fin.out,
      };
    });

    const occupancyRate =
      houses.length > 0 ? Math.round((occupied / houses.length) * 1000) / 10 : null;
    const collectionRate =
      billedCents > 0 ? Math.round((collectedCents / billedCents) * 1000) / 10 : null;

    return {
      houseType: type,
      period,
      metrics: {
        houseCount: houses.length,
        occupiedHouses: occupied,
        vacantHouses: vacant,
        tenantCount: tenants.length,
        occupancyRatePercent: occupancyRate,
        billedCents,
        collectedCents,
        outstandingCents: outstandingPeriodCents,
        openOutstandingCents,
        collectionRatePercent: collectionRate,
      },
      houses: houseRows,
    };
  },

  /** Resolve type owned by this client; throws if foreign. */
  async assertOwned(clientId, houseTypeId) {
    if (!houseTypeId) return null;
    const t = await HouseType.findOne({ _id: houseTypeId, clientId, isActive: true });
    if (!t) throw Errors.HouseTypeNotFound('House type not found for your client');
    return t;
  },
};
