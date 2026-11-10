// src/services/houseBillingConfig.service.js
// Explicit per-House billing source. Mutations serialize against charge generation.
import mongoose from 'mongoose';
import { House } from '../models/House.js';
import { HouseBillingConfig } from '../models/HouseBillingConfig.js';
import { RentCharge } from '../models/RentCharge.js';
import { Errors } from '../utils/errors.js';
import { estateFilterClause } from '../utils/estateFilter.js';

async function loadAccessibleHouse(clientId, houseId, estateFilter, session = null) {
  const query = House.findOne({
    _id: houseId,
    clientId,
    ...estateFilterClause(estateFilter),
  });
  if (session) query.session(session);
  const house = await query;
  if (!house) throw Errors.HouseNotFound();
  return house;
}

async function acquireBillingWritePoint(clientId, houseId, estateId, session) {
  const result = await House.updateOne(
    { _id: houseId, clientId, estateId },
    { $inc: { billingConfigRev: 1 } },
    { session }
  );
  if (result.matchedCount !== 1) throw Errors.HouseNotFound();
  return loadAccessibleHouse(clientId, houseId, null, session);
}

function validDate(value, fallback = null) {
  if (value == null || value === '') return fallback;
  const date = value instanceof Date ? value : new Date(value);
  if (!Number.isFinite(date.getTime())) throw Errors.InvalidRequest('Invalid billing effective date');
  return date;
}

export const houseBillingConfigService = {
  async list(clientId, houseId, estateFilter = null) {
    const house = await loadAccessibleHouse(clientId, houseId, estateFilter);
    return HouseBillingConfig.find({ clientId, estateId: house.estateId, houseId })
      .sort({ chargeType: 1, description: 1, effectiveFrom: 1 });
  },

  async upsert(clientId, houseId, body, estateFilter = null) {
    const initialHouse = await loadAccessibleHouse(clientId, houseId, estateFilter);
    const { chargeType, amountCents, dueDay, isActive } = body;
    const description = String(body.description || chargeType || '').trim();
    if (!['RENT', 'WATER', 'ELECTRICITY', 'OTHER'].includes(chargeType)) {
      throw Errors.InvalidRequest('Invalid chargeType');
    }
    if (!Number.isSafeInteger(amountCents) || amountCents < 0) {
      throw Errors.InvalidRequest('amountCents must be a non-negative safe integer');
    }
    if (!description) throw Errors.InvalidRequest('Billing description is required');
    if (isActive === false) throw Errors.InvalidRequest('Use the exact billing-line deactivation endpoint to close a line without losing its historical effective range.');

    const from = validDate(body.effectiveFrom, new Date());
    const to = validDate(body.effectiveTo, null);
    if (to && to <= from) throw Errors.InvalidRequest('effectiveTo must be later than effectiveFrom');
    const identity = {
      clientId,
      estateId: initialHouse.estateId,
      houseId,
      chargeType,
      description,
    };

    const session = await mongoose.startSession();
    let saved;
    try {
      await session.withTransaction(async () => {
        const house = await acquireBillingWritePoint(clientId, houseId, initialHouse.estateId, session);
        if (house.billingSource !== 'HOUSE_CONFIG') {
          const existingChargeCount = await RentCharge.countDocuments({ clientId, estateId: house.estateId, houseId }).session(session);
          if (existingChargeCount > 0) {
            throw Errors.Conflict('Cannot switch this House to HOUSE_CONFIG after charges exist until effective-dated House billing-source history is installed.');
          }
        }
        const sameStartRows = await HouseBillingConfig.find({
          ...identity,
          effectiveFrom: from,
        }).session(session).lean();
        if (sameStartRows.length > 1) {
          throw Errors.Conflict('Duplicate legacy billing rows share this effective start; classify them before editing this line.');
        }
        const existingAtStart = sameStartRows[0] || null;

        const overlaps = await HouseBillingConfig.find({
          ...identity,
          effectiveFrom: { $lt: to || new Date('9999-12-31T00:00:00.000Z') },
          $or: [
            { isActive: true, $or: [{ effectiveTo: null }, { effectiveTo: { $gt: from } }] },
            { isActive: false, effectiveTo: { $gt: from } },
          ],
          ...(existingAtStart ? { _id: { $ne: existingAtStart._id } } : {}),
        }).session(session).lean();

        const futureOverlap = overlaps.find((row) => row.effectiveFrom > from);
        if (futureOverlap) {
          throw Errors.Conflict('This billing line overlaps a future effective version. Choose a non-overlapping effective date.');
        }

        const priorIds = overlaps.filter((row) => row.effectiveFrom < from).map((row) => row._id);
        if (priorIds.length) {
          await HouseBillingConfig.updateMany(
            { _id: { $in: priorIds }, clientId, estateId: house.estateId, houseId },
            { $set: { effectiveTo: from } },
            { session }
          );
        }

        [saved] = await HouseBillingConfig.findOneAndUpdate(
          { ...identity, effectiveFrom: from },
          {
            $set: {
              ...identity,
              amountCents,
              dueDay: dueDay ?? house.dueDay,
              isActive: isActive !== false,
              frequency: 'monthly',
              effectiveFrom: from,
              effectiveTo: to,
            },
          },
          { upsert: true, new: true, setDefaultsOnInsert: true, session }
        ).then((doc) => [doc]);

        const hasActiveRows = await HouseBillingConfig.exists({
          ...identityHouse(house),
          isActive: true,
        }).session(session);
        await House.updateOne(
          { _id: houseId, clientId, estateId: house.estateId },
          { $set: { billingSource: hasActiveRows ? 'HOUSE_CONFIG' : 'UNCONFIGURED' } },
          { session }
        );
      });
    } finally {
      await session.endSession();
    }
    return saved;
  },

  async deactivate(clientId, houseId, configId, estateFilter = null) {
    const initialHouse = await loadAccessibleHouse(clientId, houseId, estateFilter);
    const session = await mongoose.startSession();
    let deactivated;
    try {
      await session.withTransaction(async () => {
        const house = await acquireBillingWritePoint(clientId, houseId, initialHouse.estateId, session);
        const config = await HouseBillingConfig.findOne({
          _id: configId,
          clientId,
          estateId: house.estateId,
          houseId,
        }).session(session);
        if (!config) throw Errors.NotFound('Billing configuration line not found for this House');
        if (!config.isActive) {
          deactivated = config.toObject();
          return;
        }

        const now = new Date();
        config.isActive = false;
        if (!config.effectiveTo || config.effectiveTo > now) config.effectiveTo = now;
        await config.save({ session });
        deactivated = config.toObject();

        // Keep HOUSE_CONFIG as the selected source even when no active line remains.
        // The effective-dated resolver returns no lines prospectively while preserving history.
      });
    } finally {
      await session.endSession();
    }
    return deactivated;
  },
};

function identityHouse(house) {
  return { clientId: house.clientId, estateId: house.estateId, houseId: house._id };
}
