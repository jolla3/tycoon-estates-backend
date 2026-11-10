// src/services/house.service.js
//
// Every query is scoped by clientId first — estateId / estateFilter is an
// additional filter WITHIN that client, never a substitute for clientId.
import { House } from '../models/House.js';
import { Estate } from '../models/Estate.js';
import { HouseType } from '../models/HouseType.js';
import { Tenant } from '../models/Tenant.js';
import { RentCharge } from '../models/RentCharge.js';
import { HouseBillingConfig } from '../models/HouseBillingConfig.js';
import { AuditLog } from '../models/AuditLog.js';
import { Errors } from '../utils/errors.js';
import { paginationParams, paginatedResponse } from '../utils/pagination.js';
import { estateFilterClause } from '../utils/estateFilter.js';
import { escapeRegex } from '../utils/regex.js';
import { dateUtil } from '../utils/date.js';
import { houseTypeService } from './houseType.service.js';

import mongoose from 'mongoose';
async function balanceForHouse(clientId, houseId) {
  const period = dateUtil.currentPeriod();
  const charges = await RentCharge.find({ clientId, houseId }).lean();
  let billedCents = 0;
  let paidCents = 0;
  let outstandingCents = 0;
  let currentPeriodOutstandingCents = 0;
  for (const c of charges) {
    billedCents += c.amountDueCents || 0;
    paidCents += c.amountPaidCents || 0;
    outstandingCents += Math.max(c.balanceCents || 0, 0);
    if (c.period === period) currentPeriodOutstandingCents += Math.max(c.balanceCents || 0, 0);
  }
  return { billedCents, paidCents, outstandingCents, currentPeriodOutstandingCents, period };
}

export const houseService = {
  async create(clientId, estateId, data) {
    const estate = await Estate.findOne({ _id: estateId, clientId });
    if (!estate) throw Errors.EstateNotFound('Estate not found for your client');

    let houseType = null;
    if (data.houseTypeId) {
      houseType = await houseTypeService.assertOwned(clientId, estateId, data.houseTypeId);
    }

    const monthlyRent =
      data.monthlyRent !== undefined
        ? data.monthlyRent
        : houseType
          ? (houseType.defaultRentCents || 0) / 100
          : 0;

    const dueDay = data.dueDay ?? houseType?.defaultDueDay ?? estate.defaultDueDay ?? 5;

    const house = await House.create({
      clientId,
      estateId,
      houseNumber: data.houseNumber,
      houseTypeId: houseType?._id || null,
      billingSource: houseType ? 'HOUSE_TYPE' : 'MONTHLY_RENT',
      monthlyRent,
      dueDay,
      paymentReferences: data.paymentReferences || [],
      status: data.status || 'vacant',
      isActive: data.isActive !== false,
    });

    return house;
  },

  async list(clientId, estateFilter, query) {
    const { page, limit, skip } = paginationParams(query);
    const filter = { clientId, ...estateFilterClause(estateFilter) };
    if (query.status) filter.status = query.status;
    if (query.estateId) filter.estateId = query.estateId;
    if (query.houseTypeId) filter.houseTypeId = query.houseTypeId;
    if (query.search) filter.houseNumber = new RegExp(escapeRegex(query.search), 'i');

    const [items, total] = await Promise.all([
      House.find(filter).sort({ houseNumber: 1 }).skip(skip).limit(limit).lean(),
      House.countDocuments(filter),
    ]);

    const typeIds = [...new Set(items.map((h) => h.houseTypeId).filter(Boolean).map(String))];
    const types = typeIds.length
      ? await HouseType.find({ _id: { $in: typeIds }, clientId }).lean()
      : [];
    const typeMap = new Map(types.map((t) => [String(t._id), t]));

    const tenantIds = items.map((h) => h.tenantId).filter(Boolean);
    const tenants = tenantIds.length
      ? await Tenant.find({ _id: { $in: tenantIds }, clientId }).lean()
      : [];
    const tenantMap = new Map(tenants.map((t) => [String(t._id), t]));

    const houseIds = items.map((h) => h._id);
    const period = dateUtil.currentPeriod();
    const chargeAgg = houseIds.length
      ? await RentCharge.aggregate([
          { $match: { clientId, houseId: { $in: houseIds } } },
          {
            $group: {
              _id: '$houseId',
              billedCents: { $sum: '$amountDueCents' },
              paidCents: { $sum: '$amountPaidCents' },
              outstandingCents: { $sum: { $max: ['$balanceCents', 0] } },
              currentPeriodOutstandingCents: {
                $sum: {
                  $cond: [{ $eq: ['$period', period] }, { $max: ['$balanceCents', 0] }, 0],
                },
              },
            },
          },
        ])
      : [];
    const balMap = new Map(
      chargeAgg.map((c) => [
        String(c._id),
        {
          billedCents: c.billedCents,
          paidCents: c.paidCents,
          outstandingCents: c.outstandingCents,
          currentPeriodOutstandingCents: c.currentPeriodOutstandingCents,
          period,
        },
      ])
    );

    const enriched = items.map((h) => {
      const tenant = h.tenantId ? tenantMap.get(String(h.tenantId)) : null;
      const ht = h.houseTypeId ? typeMap.get(String(h.houseTypeId)) : null;
      return {
        ...h,
        houseType: ht ? { _id: ht._id, name: ht.name } : null,
        tenant: tenant
          ? { _id: tenant._id, name: tenant.name, phone: tenant.phone, status: tenant.status }
          : null,
        balance: balMap.get(String(h._id)) || {
          billedCents: 0,
          paidCents: 0,
          outstandingCents: 0,
          currentPeriodOutstandingCents: 0,
          period,
        },
      };
    });

    return paginatedResponse(enriched, total, { page, limit });
  },

  async update(clientId, houseId, updates, estateFilter = null) {
    // Serialize every House mutation with charge generation and explicit
    // HouseBillingConfig mutations. The shared revision write is intentional:
    // MongoDB transactions then conflict instead of committing stale billing
    // source snapshots concurrently.
    const session = await mongoose.startSession();
    let updatedHouse;
    try {
      await session.withTransaction(async () => {
        const scope = {
          _id: houseId,
          clientId,
          ...estateFilterClause(estateFilter),
        };
        const lock = await House.updateOne(
          scope,
          { $inc: { billingConfigRev: 1 } },
          { session }
        );
        if ((lock.matchedCount ?? lock.n) !== 1) throw Errors.HouseNotFound();

        const current = await House.findOne(scope).session(session).lean();
        if (!current) throw Errors.HouseNotFound();

        const allowed = {};
        for (const key of ['houseNumber', 'monthlyRent', 'dueDay', 'status', 'paymentReferences']) {
          if (updates[key] !== undefined) allowed[key] = updates[key];
        }
        if (typeof updates.isActive === 'boolean') allowed.isActive = updates.isActive;

        const hasOwn = (object, key) => Object.prototype.hasOwnProperty.call(object, key);
        const currentSource = current.billingSource || 'LEGACY_UNCLASSIFIED';

        if (updates.houseTypeId !== undefined) {
          if (updates.houseTypeId === null || updates.houseTypeId === '') {
            allowed.houseTypeId = null;
            // Clearing an assignment must not silently change an unrelated
            // explicit source such as HOUSE_CONFIG or MONTHLY_RENT.
            if (currentSource === 'HOUSE_TYPE' && updates.billingSource === undefined) {
              allowed.billingSource = 'UNCONFIGURED';
            }
          } else {
            const type = await houseTypeService.assertOwned(
              clientId,
              current.estateId,
              updates.houseTypeId
            );
            allowed.houseTypeId = type._id;
            allowed.billingSource = 'HOUSE_TYPE';
          }
        }

        if (updates.billingSource !== undefined) {
          const choices = ['HOUSE_TYPE', 'HOUSE_CONFIG', 'MONTHLY_RENT', 'UNCONFIGURED'];
          if (!choices.includes(updates.billingSource)) {
            throw Errors.InvalidRequest('Invalid billingSource');
          }
          const resultingHouseTypeId = hasOwn(allowed, 'houseTypeId')
            ? allowed.houseTypeId
            : current.houseTypeId;

          if (updates.billingSource === 'HOUSE_TYPE') {
            if (!resultingHouseTypeId) {
              throw Errors.InvalidRequest('HOUSE_TYPE billing requires a HouseType assignment');
            }
            await houseTypeService.assertOwned(clientId, current.estateId, resultingHouseTypeId);
          }

          if (updates.billingSource === 'HOUSE_CONFIG') {
            const hasConfig = await HouseBillingConfig.exists({
              clientId,
              estateId: current.estateId,
              houseId: current._id,
              isActive: true,
              $or: [{ effectiveTo: null }, { effectiveTo: { $gt: new Date() } }],
            }).session(session);
            if (!hasConfig) {
              throw Errors.InvalidRequest('HOUSE_CONFIG billing requires an active HouseBillingConfig line');
            }
          }
          allowed.billingSource = updates.billingSource;
        }

        const nextSource = hasOwn(allowed, 'billingSource')
          ? allowed.billingSource
          : currentSource;
        const nextHouseTypeId = hasOwn(allowed, 'houseTypeId')
          ? allowed.houseTypeId
          : current.houseTypeId;
        const houseTypeChanged = String(nextHouseTypeId || '') !== String(current.houseTypeId || '');
        const sourceChanged = nextSource !== currentSource;
        const monthlyRentChanged = hasOwn(allowed, 'monthlyRent')
          && Number(allowed.monthlyRent) !== Number(current.monthlyRent);
        const dueDayChanged = hasOwn(allowed, 'dueDay')
          && Number(allowed.dueDay) !== Number(current.dueDay);

        const billingTermsChanged = sourceChanged
          || ((currentSource === 'HOUSE_TYPE' || nextSource === 'HOUSE_TYPE') && houseTypeChanged)
          || ((currentSource === 'MONTHLY_RENT' || nextSource === 'MONTHLY_RENT')
            && (monthlyRentChanged || dueDayChanged));

        if (billingTermsChanged) {
          const existingChargeCount = await RentCharge.countDocuments({
            clientId,
            estateId: current.estateId,
            houseId: current._id,
          }).session(session);
          if (existingChargeCount > 0) {
            throw Errors.Conflict(
              'Cannot change this House billing source or its active billing terms after charges exist. '
              + 'Install effective-dated House billing-source history before making that change.'
            );
          }
        }

        updatedHouse = await House.findOneAndUpdate(
          scope,
          { $set: allowed },
          { new: true, runValidators: true, session }
        );
        if (!updatedHouse) throw Errors.HouseNotFound();
      });
    } finally {
      await session.endSession();
    }
    return updatedHouse;
  },

  async get(clientId, houseId, estateFilter = null) {
    const house = await House.findOne({
      _id: houseId,
      clientId,
      ...estateFilterClause(estateFilter),
    }).lean();
    if (!house) throw Errors.HouseNotFound();

    const [estate, houseType, tenant, balance, billingConfigs] = await Promise.all([
      Estate.findOne({ _id: house.estateId, clientId }).lean(),
      house.houseTypeId
        ? HouseType.findOne({ _id: house.houseTypeId, clientId }).lean()
        : null,
      house.tenantId ? Tenant.findOne({ _id: house.tenantId, clientId }).lean() : null,
      balanceForHouse(clientId, house._id),
      HouseBillingConfig.find({ clientId, houseId: house._id }).lean(),
    ]);

    const activity = await AuditLog.find({
      clientId,
      $or: [
        { resource: 'House', resourceId: house._id },
        { resource: 'Tenant', resourceId: house.tenantId },
        { resource: 'RentCharge', resourceId: { $exists: true }, estateId: house.estateId },
      ],
    })
      .sort({ createdAt: -1 })
      .limit(30)
      .lean();

    // Narrow activity to this house where possible
    const houseActivity = activity.filter(
      (a) =>
        String(a.resourceId) === String(house._id) ||
        (house.tenantId && String(a.resourceId) === String(house.tenantId)) ||
        a.metadata?.houseId === String(house._id)
    );

    return {
      ...house,
      estate: estate ? { _id: estate._id, name: estate.name, address: estate.address } : null,
      houseType: houseType ? { _id: houseType._id, name: houseType.name } : null,
      tenant: tenant
        ? { _id: tenant._id, name: tenant.name, phone: tenant.phone, status: tenant.status }
        : null,
      balance,
      billingConfigs,
      activity: houseActivity.slice(0, 20),
    };
  },
};
