// src/services/houseBillingConfig.service.js
import { House } from '../models/House.js';
import { HouseBillingConfig } from '../models/HouseBillingConfig.js';
import { Errors } from '../utils/errors.js';
import { estateFilterClause } from '../utils/estateFilter.js';

async function loadAccessibleHouse(clientId, houseId, estateFilter) {
  const house = await House.findOne({
    _id: houseId,
    clientId,
    ...estateFilterClause(estateFilter),
  });
  if (!house) throw Errors.HouseNotFound();
  return house;
}

export const houseBillingConfigService = {
  async list(clientId, houseId, estateFilter = null) {
    await loadAccessibleHouse(clientId, houseId, estateFilter);
    return HouseBillingConfig.find({ clientId, houseId }).sort({ chargeType: 1 });
  },

  async upsert(clientId, houseId, body, estateFilter = null) {
    const house = await loadAccessibleHouse(clientId, houseId, estateFilter);
    const { chargeType, description, amountCents, dueDay, isActive, effectiveFrom } = body;

    if (!['RENT', 'WATER', 'ELECTRICITY', 'OTHER'].includes(chargeType)) {
      throw Errors.InvalidRequest('Invalid chargeType');
    }
    if (!Number.isInteger(amountCents) || amountCents < 0) {
      throw Errors.InvalidRequest('amountCents must be a non-negative integer');
    }

    return HouseBillingConfig.findOneAndUpdate(
      { clientId, houseId, chargeType },
      {
        clientId,
        estateId: house.estateId,
        houseId,
        chargeType,
        description: description || chargeType,
        amountCents,
        dueDay: dueDay ?? house.dueDay,
        isActive: isActive !== false,
        frequency: 'monthly',
        ...(effectiveFrom ? { effectiveFrom } : {}),
      },
      { upsert: true, new: true, setDefaultsOnInsert: true }
    );
  },

  async deactivate(clientId, houseId, chargeType, estateFilter = null) {
    await loadAccessibleHouse(clientId, houseId, estateFilter);
    const doc = await HouseBillingConfig.findOneAndUpdate(
      { clientId, houseId, chargeType },
      { isActive: false },
      { new: true }
    );
    if (!doc) throw Errors.NotFound('Billing configuration not found');
    return doc;
  },
};
