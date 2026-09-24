// src/services/estate.service.js
import { Estate } from '../models/Estate.js';
import { House } from '../models/House.js';
import { Tenant } from '../models/Tenant.js';
import { RentCharge } from '../models/RentCharge.js';
import { Errors } from '../utils/errors.js';
import { estateFilterClause } from '../utils/estateFilter.js';
import { dateUtil } from '../utils/date.js';

export const estateService = {
  create: (clientId, data) => Estate.create({ ...data, clientId }),

  async list(clientId, estateFilter) {
    const estates = await Estate.find({
      clientId,
      isActive: true,
      ...estateFilterClause(estateFilter),
    }).lean();
    if (!estates.length) return [];

    const estateIds = estates.map((e) => e._id);
    const period = dateUtil.currentPeriod();

    const [houses, tenants, periodCharges, openCharges, typeCounts] = await Promise.all([
      House.find({ clientId, estateId: { $in: estateIds }, isActive: true }).lean(),
      Tenant.find({ clientId, estateId: { $in: estateIds }, status: 'active' }).lean(),
      RentCharge.find({ clientId, estateId: { $in: estateIds }, period }).lean(),
      RentCharge.find({
        clientId,
        estateId: { $in: estateIds },
        status: { $in: ['UNPAID', 'PARTIAL'] },
      }).lean(),
      House.aggregate([
        { $match: { clientId, estateId: { $in: estateIds }, isActive: true, houseTypeId: { $ne: null } } },
        { $group: { _id: { estateId: '$estateId', houseTypeId: '$houseTypeId' }, count: { $sum: 1 } } },
      ]),
    ]);

    const byEstate = (rows, idKey = 'estateId') => {
      const m = new Map();
      for (const r of rows) {
        const k = String(r[idKey] || r._id?.estateId || r.estateId);
        if (!m.has(k)) m.set(k, []);
        m.get(k).push(r);
      }
      return m;
    };

    const housesBy = byEstate(houses);
    const tenantsBy = byEstate(tenants);
    const chargesBy = byEstate(periodCharges);
    const openBy = byEstate(openCharges);

    const typeCountByEstate = new Map();
    for (const row of typeCounts) {
      const eid = String(row._id.estateId);
      typeCountByEstate.set(eid, (typeCountByEstate.get(eid) || 0) + 1);
    }

    return estates.map((e) => {
      const eid = String(e._id);
      const hs = housesBy.get(eid) || [];
      const ts = tenantsBy.get(eid) || [];
      const cs = chargesBy.get(eid) || [];
      const os = openBy.get(eid) || [];
      let occupied = 0;
      let vacant = 0;
      let unclassified = 0;
      for (const h of hs) {
        if (h.status === 'occupied') occupied += 1;
        else vacant += 1;
        if (!h.houseTypeId) unclassified += 1;
      }
      let billed = 0;
      let collected = 0;
      let outstandingPeriod = 0;
      for (const c of cs) {
        billed += c.amountDueCents || 0;
        collected += c.amountPaidCents || 0;
        outstandingPeriod += Math.max(c.balanceCents || 0, 0);
      }
      let openOutstanding = 0;
      for (const c of os) openOutstanding += Math.max(c.balanceCents || 0, 0);
      const collectionRate =
        billed > 0 ? Math.round((collected / billed) * 1000) / 10 : null;
      return {
        ...e,
        metrics: {
          houseCount: hs.length,
          occupiedHouses: occupied,
          vacantHouses: vacant,
          unclassifiedHouses: unclassified,
          tenantCount: ts.length,
          houseTypeCount: typeCountByEstate.get(eid) || 0,
          period,
          billedCents: billed,
          collectedCents: collected,
          outstandingCents: outstandingPeriod,
          openOutstandingCents: openOutstanding,
          collectionRatePercent: collectionRate,
        },
      };
    });
  },

  async get(clientId, estateId, estateFilter = null) {
    const estate = await Estate.findOne({
      _id: estateId,
      clientId,
      ...estateFilterClause(estateFilter),
    });
    if (!estate) throw Errors.EstateNotFound();
    return estate;
  },

  async update(clientId, estateId, updates, estateFilter = null) {
    const allowed = {};
    if (updates.name !== undefined) allowed.name = updates.name;
    if (updates.address !== undefined) allowed.address = updates.address;
    if (updates.defaultDueDay !== undefined) allowed.defaultDueDay = updates.defaultDueDay;
    if (typeof updates.isActive === 'boolean') allowed.isActive = updates.isActive;
    const estate = await Estate.findOneAndUpdate(
      { _id: estateId, clientId, ...estateFilterClause(estateFilter) },
      allowed,
      { new: true }
    );
    if (!estate) throw Errors.EstateNotFound();
    return estate;
  },

  /**
   * Operational summary for the estate workspace.
   * Metrics computed only from live House / Tenant / RentCharge data.
   */
  async workspace(clientId, estateId, estateFilter = null) {
    const estate = await this.get(clientId, estateId, estateFilter);
    const period = dateUtil.currentPeriod();

    const [houses, tenants, charges] = await Promise.all([
      House.find({ clientId, estateId, isActive: true }).lean(),
      Tenant.find({ clientId, estateId, status: 'active' }).lean(),
      RentCharge.find({ clientId, estateId, period }).lean(),
    ]);

    let occupied = 0;
    let vacant = 0;
    for (const h of houses) {
      if (h.status === 'occupied') occupied += 1;
      else vacant += 1;
    }

    let billedCents = 0;
    let collectedCents = 0;
    let outstandingCents = 0;
    for (const c of charges) {
      billedCents += c.amountDueCents || 0;
      collectedCents += c.amountPaidCents || 0;
      outstandingCents += Math.max(c.balanceCents || 0, 0);
    }

    // All-time outstanding (open balances) for the estate
    const openCharges = await RentCharge.find({
      clientId,
      estateId,
      status: { $in: ['UNPAID', 'PARTIAL'] },
    }).lean();
    let openOutstandingCents = 0;
    for (const c of openCharges) openOutstandingCents += Math.max(c.balanceCents || 0, 0);

    // HouseType breakdown (real counts + period financials from RentCharge)
    const { HouseType } = await import('../models/HouseType.js');
    const typeIds = [...new Set(houses.map((h) => h.houseTypeId).filter(Boolean).map(String))];
    const types = typeIds.length
      ? await HouseType.find({ _id: { $in: typeIds }, clientId }).lean()
      : [];
    const typeMap = new Map(types.map((t) => [String(t._id), t]));

    const byType = new Map();
    for (const h of houses) {
      const key = h.houseTypeId ? String(h.houseTypeId) : '__none__';
      if (!byType.has(key)) {
        byType.set(key, {
          houseTypeId: h.houseTypeId || null,
          name: h.houseTypeId ? typeMap.get(String(h.houseTypeId))?.name || 'Unknown' : 'Unclassified',
          houseCount: 0,
          occupied: 0,
          vacant: 0,
          billedCents: 0,
          collectedCents: 0,
          outstandingCents: 0,
        });
      }
      const row = byType.get(key);
      row.houseCount += 1;
      if (h.status === 'occupied') row.occupied += 1;
      else row.vacant += 1;
    }
    const houseIdToType = new Map(houses.map((h) => [String(h._id), h.houseTypeId ? String(h.houseTypeId) : '__none__']));
    for (const c of charges) {
      const tk = houseIdToType.get(String(c.houseId)) || '__none__';
      const row = byType.get(tk);
      if (!row) continue;
      row.billedCents += c.amountDueCents || 0;
      row.collectedCents += c.amountPaidCents || 0;
      row.outstandingCents += Math.max(c.balanceCents || 0, 0);
    }

    const unclassifiedHouses = houses.filter((h) => !h.houseTypeId).length;

    return {
      estate: {
        _id: estate._id,
        name: estate.name,
        address: estate.address,
        currency: estate.currency,
        defaultDueDay: estate.defaultDueDay,
        isActive: estate.isActive,
      },
      period,
      metrics: {
        houseCount: houses.length,
        occupiedHouses: occupied,
        vacantHouses: vacant,
        unclassifiedHouses,
        tenantCount: tenants.length,
        currentPeriodBilledCents: billedCents,
        currentPeriodCollectedCents: collectedCents,
        currentPeriodOutstandingCents: outstandingCents,
        openOutstandingCents,
        collectionRatePercent:
          billedCents > 0 ? Math.round((collectedCents / billedCents) * 1000) / 10 : null,
      },
      byHouseType: [...byType.values()].sort((a, b) => a.name.localeCompare(b.name)),
    };
  },
};
