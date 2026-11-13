// src/services/rent.service.js
// G3: Tenancy-aware charge generation. HouseType is the shared plan source.
// Eligible monthly tenancy: startAt <= periodStart AND (endAt == null OR endAt >= nextPeriodStart).

import mongoose from 'mongoose';
import { House } from '../models/House.js';
import { Estate } from '../models/Estate.js';
import { RentCharge } from '../models/RentCharge.js';
import { HouseBillingConfig } from '../models/HouseBillingConfig.js';
import { HouseType, assertUniquePlanLines } from '../models/HouseType.js';
import { resolveHouseTypePlanVersion } from './houseTypePlanVersion.service.js';
import { Tenancy } from '../models/Tenancy.js';
import { dateUtil } from '../utils/date.js';
import { money } from '../utils/money.js';
import { estateFilterClause } from '../utils/estateFilter.js';
import { autoApplyCredit } from './tenantCredit.service.js';
import { audit } from './audit.service.js';
import { assertBillingIndexesAligned } from '../utils/billingIndexReadiness.js';
import { supportsMongoTransactions } from '../config/database.js';
import { Errors } from '../utils/errors.js';
import { isTenancyEligibleForPeriod } from '../utils/tenancyEligibility.js';

function resolveDueDay(house, estate, configDueDay) {
  if (configDueDay != null) return configDueDay;
  if (house?.dueDay != null) return house.dueDay;
  if (estate?.defaultDueDay != null) return estate.defaultDueDay;
  return 5;
}

function sameId(a, b) {
  return a != null && b != null && String(a) === String(b);
}

function sameNullableId(a, b) {
  if (a == null && b == null) return true;
  return sameId(a, b);
}

function assertTenancyHouseScope({ clientId, estateId, house, tenancy }) {
  if (!sameId(house.clientId, clientId)
    || !sameId(house.estateId, estateId)
    || !sameId(tenancy.clientId, clientId)
    || !sameId(tenancy.estateId, estateId)
    || !sameId(tenancy.houseId, house._id)) {
    throw Errors.Conflict(
      'RentCharge generation scope does not match the supplied House and Tenancy'
    );
  }
}

function assertExistingChargeIdentity(charge, expected) {
  const matches =
    sameId(charge.clientId, expected.clientId)
    && sameId(charge.estateId, expected.estateId)
    && sameId(charge.houseId, expected.houseId)
    && sameNullableId(charge.tenantId, expected.tenantId)
    && sameId(charge.tenancyId, expected.tenancyId)
    && charge.period === expected.period
    && charge.chargeType === expected.chargeType
    && charge.description === expected.description;

  if (!matches) {
    throw Errors.Conflict(
      'Existing RentCharge identity matches the key but its ownership or scope does not'
    );
  }

  return charge;
}

function isRentChargeIdentityDuplicate(error) {
  if (Number(error?.code) !== 11000 || !error?.keyPattern) return false;

  const keys = Object.entries(error.keyPattern);
  const expected = [
    ['tenancyId', 1],
    ['period', 1],
    ['chargeType', 1],
    ['description', 1],
  ];

  return keys.length === expected.length
    && expected.every(([key, direction], index) =>
      keys[index]?.[0] === key && keys[index]?.[1] === direction
    );
}

function periodBounds(period) {
  const periodStart = dateUtil.startOfMonth(period).toDate();
  const nextPeriodStart = dateUtil.startOfMonth(period).add(1, 'month').toDate();
  return { periodStart, nextPeriodStart };
}

async function planLinesForHouse(house, period, { session } = {}) {
  const estateQuery = Estate.findOne({ _id: house.estateId, clientId: house.clientId });
  if (session) estateQuery.session(session);
  const estate = await estateQuery.lean();
  if (!estate) throw Errors.Conflict('House Estate ownership could not be verified for billing');
  const source = house.billingSource || 'LEGACY_UNCLASSIFIED';
  const emptyMeta = { planId: null, planVersionId: null, planVersion: null };

  if (source === 'UNCONFIGURED') return { lines: [], planMeta: emptyMeta, estate, source };
  if (source === 'LEGACY_UNCLASSIFIED') {
    throw Errors.Conflict(`House ${house._id} has unclassified legacy billing source; generation is blocked.`);
  }

  if (source === 'HOUSE_TYPE') {
    if (!house.houseTypeId) throw Errors.Conflict('HOUSE_TYPE billing requires houseTypeId');
    const typeQuery = HouseType.findOne({ _id: house.houseTypeId, clientId: house.clientId, estateId: house.estateId });
    if (session) typeQuery.session(session);
    const type = await typeQuery.lean();
    if (!type) throw Errors.Conflict('HouseType does not belong to this House Estate');
    const version = await resolveHouseTypePlanVersion({
      clientId: house.clientId, estateId: house.estateId, houseTypeId: type._id, period, session,
    });
    if (!version) return { lines: [], planMeta: { ...emptyMeta, planId: type._id }, estate, source };
    const lines = (version.lines || []).map((line) => ({
      chargeType: line.chargeType,
      description: String(line.description || line.chargeType || '').trim(),
      amountCents: line.amountCents,
      dueDay: line.dueDay,
      planLineId: line.lineId,
    }));
    assertUniquePlanLines(lines);
    return {
      lines,
      planMeta: { planId: type._id, planVersionId: version._id, planVersion: version.version },
      estate,
      source,
    };
  }

  if (source === 'HOUSE_CONFIG') {
    const at = dateUtil.startOfMonth(period).toDate();
    const configQuery = HouseBillingConfig.find({
      clientId: house.clientId, estateId: house.estateId, houseId: house._id,
      effectiveFrom: { $lte: at },
      $or: [
        { isActive: true, $or: [{ effectiveTo: null }, { effectiveTo: { $gt: at } }] },
        { isActive: false, effectiveTo: { $gt: at } },
      ],
    });
    if (session) configQuery.session(session);
    const configs = await configQuery.lean();
    const lines = configs.map((config) => ({
      chargeType: config.chargeType,
      description: String(config.description || config.chargeType || '').trim(),
      amountCents: config.amountCents,
      dueDay: config.dueDay,
      planLineId: `HOUSE_CONFIG:${config._id}`,
      billingConfigId: config._id,
    }));
    assertUniquePlanLines(lines);
    return { lines, planMeta: emptyMeta, estate, source };
  }

  if (source === 'MONTHLY_RENT') {
    const amountCents = money.toCents(house.monthlyRent);
    const lines = amountCents > 0 ? [{
      chargeType: 'RENT', description: 'Rent', amountCents,
      dueDay: house.dueDay, planLineId: `MONTHLY_RENT:${house._id}`,
    }] : [];
    return { lines, planMeta: emptyMeta, estate, source };
  }
  throw Errors.InvalidRequest(`Unsupported House billing source: ${source}`);
}

async function ensureChargeAndLedger({
  clientId, estateId, house, tenancy, period, line, planMeta, estate, session,
}) {
  const description = (line.description || line.chargeType || '').trim() || line.chargeType;
  const dueDay = resolveDueDay(house, estate, line.dueDay);
  const amountDueCents = line.amountCents;

  if (!tenancy?._id) throw Errors.InvalidRequest('tenancyId is required for new RentCharges');
  assertTenancyHouseScope({ clientId, estateId, house, tenancy });
  if (!Number.isInteger(amountDueCents) || amountDueCents <= 0) {
    return { charge: null, created: false };
  }

  const expectedIdentity = {
    clientId, estateId, houseId: house._id, tenantId: tenancy.tenantId ?? null,
    tenancyId: tenancy._id, period, chargeType: line.chargeType, description,
  };

  let charge = await RentCharge.findOne({
    tenancyId: tenancy._id, period, chargeType: line.chargeType, description,
  }).session(session);

  let created = false;
  if (charge) {
    assertExistingChargeIdentity(charge, expectedIdentity);
  } else {
    try {
      const [doc] = await RentCharge.create([
        {
          ...expectedIdentity,
          amountDueCents, amountPaidCents: 0, balanceCents: amountDueCents,
          status: 'UNPAID', dueDate: dateUtil.dueDateFor(period, dueDay),
          billingConfigId: line.billingConfigId || null,
          planId: planMeta.planId, planVersionId: planMeta.planVersionId || null,
          planVersion: planMeta.planVersion, planLineId: line.planLineId || null,
          billingSource: house.billingSource, allocationRev: 0,
        },
      ], { session });
      charge = doc;
      created = true;
    } catch (error) {
      if (isRentChargeIdentityDuplicate(error)) error.g3RentChargeIdentityConflict = true;
      throw error;
    }
  }

  const { ledgerService } = await import('./ledger.service.js');
  await ledgerService.postEntry({
    clientId, estateId, houseId: house._id, tenantId: tenancy.tenantId || null,
    tenancyId: tenancy._id, accountCategory: 'RENT', entryType: 'CHARGE',
    amountCents: -Math.abs(charge.amountDueCents),
    referenceType: 'RentCharge', referenceId: charge._id,
    description: `${charge.chargeType} ${period}`, period,
  }, { session });

  return { charge, created };
}

export { isTenancyEligibleForPeriod };

export const rentService = {
  isTenancyEligibleForPeriod,

  async generateChargesForEstate(clientId, estateId, period = dateUtil.currentPeriod()) {
    await assertBillingIndexesAligned();
    if (supportsMongoTransactions() !== true) {
      throw Errors.ServiceUnavailable('MongoDB transactions required for charge generation');
    }

    const estate = await Estate.findOne({ _id: estateId, clientId }).lean();
    if (!estate) throw Errors.EstateNotFound?.() || Errors.NotFound('Estate not found');

    const { periodStart, nextPeriodStart } = periodBounds(period);

    const tenancies = await Tenancy.find({
      clientId, estateId, status: { $in: ['ACTIVE', 'CLOSED'] },
      startAt: { $lte: periodStart },
      $or: [{ endAt: null }, { endAt: { $gte: nextPeriodStart } }],
    }).lean();

    const partial = await Tenancy.find({
      clientId, estateId, status: { $in: ['ACTIVE', 'CLOSED'] },
      $or: [
        { startAt: { $gt: periodStart, $lt: nextPeriodStart } },
        { endAt: { $gt: periodStart, $lt: nextPeriodStart } },
      ],
    }).select('_id houseId startAt endAt status').lean();

    let created = 0;
    const session = await mongoose.startSession();
    try {
      for (const candidateTenancy of tenancies) {
        let committedCreated = 0;
        await session.withTransaction(async () => {
          const tenancy = await Tenancy.findOne({
            _id: candidateTenancy._id, clientId, estateId,
            status: { $in: ['ACTIVE', 'CLOSED'] },
          }).session(session).lean();
          if (!tenancy || !isTenancyEligibleForPeriod(tenancy, period)) {
            committedCreated = 0; return;
          }
          const lock = await House.updateOne(
            { _id: tenancy.houseId, clientId, estateId, isActive: true },
            { $inc: { billingConfigRev: 1 } }, { session }
          );
          if (lock.matchedCount !== 1) { committedCreated = 0; return; }
          const house = await House.findOne({
            _id: tenancy.houseId, clientId, estateId, isActive: true,
          }).session(session).lean();
          if (!house) { committedCreated = 0; return; }

          const { lines, planMeta, estate: est } = await planLinesForHouse(house, period, { session });
          let attemptCreated = 0;
          for (const line of lines) {
            if (!line.amountCents || line.amountCents <= 0) continue;
            const result = await ensureChargeAndLedger({
              clientId, estateId, house, tenancy, period, line, planMeta,
              estate: est || estate, session,
            });
            if (result.created) attemptCreated += 1;
          }
          committedCreated = attemptCreated;
        });
        created += committedCreated;
      }
    } finally {
      session.endSession();
    }

    if (created > 0) {
      await audit({
        clientId, estateId, action: 'BILL_GENERATED', resource: 'RentCharge',
        description: `Generated ${created} charges for period ${period}`,
        metadata: { created, period, eligibleTenancies: tenancies.length, partialPeriodExcluded: partial.length },
      });
    }

    // Tenant credit reconciliation AFTER all Estate charges. Not gated on created > 0.
    const tenantIds = [...new Set(tenancies.map((t) => String(t.tenantId)).filter(Boolean))];
    let creditAppliedCents = 0;
    const creditResults = [];
    for (const tenantId of tenantIds.sort()) {
      const r = await autoApplyCredit({ clientId, estateId, tenantId });
      if (r.applied > 0) {
        creditAppliedCents += r.applied;
        creditResults.push({ tenantId, applied: r.applied });
      }
    }

    return {
      created, period, eligibleTenancies: tenancies.length,
      partialPeriodExcluded: partial.length,
      partialPeriodTenancyIds: partial.slice(0, 20).map((t) => String(t._id)),
      creditAppliedCents, creditTenantCount: creditResults.length,
    };
  },

  async ensureChargesForTenancy(clientId, tenancy, house, period, { session } = {}) {
    await assertBillingIndexesAligned();
    if (!tenancy?._id) throw Errors.InvalidRequest('tenancy is required');
    if (house && String(house._id) !== String(tenancy.houseId)) {
      throw Errors.Conflict('Supplied House does not belong to the requested Tenancy.');
    }
    const run = async (ses) => {
      const lock = await House.updateOne(
        { _id: tenancy.houseId, clientId, estateId: tenancy.estateId },
        { $inc: { billingConfigRev: 1 } }, { session: ses }
      );
      if (lock.matchedCount !== 1) throw Errors.HouseNotFound();
      const scopedHouse = await House.findOne({
        _id: tenancy.houseId, clientId, estateId: tenancy.estateId,
      }).session(ses).lean();
      if (!scopedHouse) throw Errors.HouseNotFound();
      const currentTenancy = await Tenancy.findOne({
        _id: tenancy._id, clientId, estateId: tenancy.estateId, houseId: scopedHouse._id,
      }).session(ses).lean();
      if (!currentTenancy) throw Errors.NotFound('Tenancy does not belong to the selected House/Estate');
      if (!isTenancyEligibleForPeriod(currentTenancy, period)) {
        throw Errors.InvalidRequest('Tenancy does not cover the full billing period; partial-period billing remains blocked pending owner policy.');
      }
      assertTenancyHouseScope({ clientId, estateId: scopedHouse.estateId, house: scopedHouse, tenancy: currentTenancy });
      const { lines, planMeta, estate } = await planLinesForHouse(scopedHouse, period, { session: ses });
      const charges = [];
      for (const line of lines) {
        if (!line.amountCents || line.amountCents <= 0) continue;
        const { charge } = await ensureChargeAndLedger({
          clientId, estateId: scopedHouse.estateId, house: scopedHouse, tenancy: currentTenancy,
          period, line, planMeta, estate, session: ses,
        });
        if (charge) charges.push(charge);
      }
      return charges;
    };
    if (session) return run(session);
    if (supportsMongoTransactions() !== true) {
      throw Errors.ServiceUnavailable('MongoDB transactions required for charge ensure');
    }
    const ses = await mongoose.startSession();
    try {
      let result;
      await ses.withTransaction(async () => { result = await run(ses); });
      return result;
    } finally {
      ses.endSession();
    }
  },

  async ensureChargesForHouse(clientId, house, tenant, period, { session, tenancyId = null } = {}) {
    await assertBillingIndexesAligned();
    let tenancy = null;
    if (tenancyId) {
      tenancy = await Tenancy.findOne({ _id: tenancyId, clientId }).session(session || null).lean();
      if (!tenancy) throw Errors.NotFound('Tenancy not found');
      if (String(tenancy.houseId) !== String(house._id)) {
        throw Errors.InvalidRequest('tenancyId does not belong to the selected house');
      }
    } else {
      const { tenancyService } = await import('./tenancy.service.js');
      const at = dateUtil.startOfMonth(period).toDate();
      tenancy = await tenancyService.findUniqueForHouseAt(clientId, house._id, at, { session });
      if (!tenancy) throw Errors.InvalidRequest('No unique tenancy for house/period; supply tenancyId explicitly');
      if (!isTenancyEligibleForPeriod(tenancy, period)) {
        throw Errors.InvalidRequest('Resolved tenancy does not cover the full billing period; partial-period billing is blocked pending owner policy');
      }
    }
    return this.ensureChargesForTenancy(clientId, tenancy, house, period, { session });
  },

  async getOrCreateChargeForHouse(clientId, house, tenant, period, { session, tenancyId = null } = {}) {
    const charges = await this.ensureChargesForHouse(clientId, house, tenant, period, { session, tenancyId });
    return charges.find((c) => c.chargeType === 'RENT') || charges[0] || null;
  },

  async outstandingChargesForTenancy(clientId, tenancyId, { session } = {}) {
    if (!tenancyId) return [];
    return RentCharge.find({
      clientId, tenancyId, status: { $in: ['UNPAID', 'PARTIAL', 'OVERPAID'] },
    }).session(session || null).sort({ period: 1, chargeType: 1 });
  },

  async outstandingChargesForHouse(clientId, houseId, { session } = {}) {
    return RentCharge.find({
      clientId, houseId, status: { $in: ['UNPAID', 'PARTIAL', 'OVERPAID'] },
    }).session(session || null).sort({ period: 1, chargeType: 1 });
  },

  async previousArrears(clientId, houseId, period) {
    const charges = await RentCharge.find({
      clientId, houseId, period: { $lt: period }, status: { $in: ['UNPAID', 'PARTIAL'] },
    }).lean();
    const byType = {};
    const byTenancy = {};
    let totalCents = 0;
    for (const c of charges) {
      const t = c.chargeType || 'RENT';
      byType[t] = (byType[t] || 0) + c.balanceCents;
      totalCents += c.balanceCents;
      const tid = c.tenancyId ? String(c.tenancyId) : 'unattributed';
      byTenancy[tid] = (byTenancy[tid] || 0) + c.balanceCents;
    }
    return { totalCents, byType, byTenancy, charges };
  },

  async generateForClient(clientId, { estateId = null, period = null, estateFilter = null } = {}) {
    const p = period || dateUtil.currentPeriod();
    const estateQuery = { clientId, isActive: true, ...estateFilterClause(estateFilter) };
    if (estateId) estateQuery._id = estateId;
    const estates = await Estate.find(estateQuery).lean();
    let created = 0;
    let creditAppliedCents = 0;
    for (const estate of estates) {
      const r = await this.generateChargesForEstate(clientId, estate._id, p);
      created += r.created || 0;
      creditAppliedCents += r.creditAppliedCents || 0;
    }
    return { created, period: p, estates: estates.length, creditAppliedCents };
  },

  async houseAccount(clientId, houseId, estateFilter = null) {
    const house = await House.findOne({ _id: houseId, clientId, ...estateFilterClause(estateFilter) }).lean();
    if (!house) throw Errors.HouseNotFound();
    const charges = await RentCharge.find({ clientId, houseId }).sort({ period: 1, chargeType: 1 }).lean();
    return { house, charges };
  },

  async summary(clientId, estateFilter = null, period = dateUtil.currentPeriod()) {
    const houseFilter = { clientId, isActive: true, ...estateFilterClause(estateFilter) };
    const houses = await House.find(houseFilter).select('_id').lean();
    const houseIds = houses.map((h) => h._id);
    const charges = houseIds.length
      ? await RentCharge.find({ clientId, houseId: { $in: houseIds }, period }).lean()
      : [];
    const summary = {
      period, houses: houses.length, paid: 0, partial: 0, unpaid: 0,
      expectedCents: 0, collectedCents: 0, byChargeType: {},
    };
    const houseStatus = new Map();
    for (const c of charges) {
      const type = c.chargeType || 'RENT';
      if (!summary.byChargeType[type]) {
        summary.byChargeType[type] = { billedCents: 0, paidCents: 0, outstandingCents: 0 };
      }
      summary.byChargeType[type].billedCents += c.amountDueCents;
      summary.byChargeType[type].paidCents += c.amountPaidCents;
      summary.byChargeType[type].outstandingCents += Math.max(c.balanceCents, 0);
      summary.expectedCents += c.amountDueCents;
      summary.collectedCents += c.amountPaidCents;
      const hid = String(c.houseId);
      const prev = houseStatus.get(hid) || 'PAID';
      if (c.status === 'UNPAID' || prev === 'UNPAID') {
        houseStatus.set(hid, c.status === 'PARTIAL' && prev === 'PAID' ? 'PARTIAL' : c.status === 'UNPAID' ? 'UNPAID' : prev);
      } else if (c.status === 'PARTIAL') houseStatus.set(hid, 'PARTIAL');
      else if (!houseStatus.has(hid)) houseStatus.set(hid, c.status);
    }
    for (const st of houseStatus.values()) {
      if (st === 'PAID' || st === 'OVERPAID') summary.paid += 1;
      else if (st === 'PARTIAL') summary.partial += 1;
      else summary.unpaid += 1;
    }
    summary.outstandingCents = summary.expectedCents - summary.collectedCents;
    return summary;
  },
};
