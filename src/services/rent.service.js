// src/services/rent.service.js
// G3: Tenancy-aware charge generation. HouseType is the shared plan source.
// Monthly eligibility is tenancy overlap with the full Nairobi calendar date of the effective RENT due day.

import mongoose from 'mongoose';
import { House } from '../models/House.js';
import { Estate } from '../models/Estate.js';
import { RentCharge } from '../models/RentCharge.js';
import { HouseBillingConfig } from '../models/HouseBillingConfig.js';
import { Tenancy } from '../models/Tenancy.js';
import { dateUtil } from '../utils/date.js';
import { money } from '../utils/money.js';
import { estateFilterClause } from '../utils/estateFilter.js';
import { audit } from './audit.service.js';
import { autoApplyCredit } from './tenantCredit.service.js';
import { assertBillingIndexesAligned } from '../utils/billingIndexReadiness.js';
import { supportsMongoTransactions } from '../config/database.js';
import { Errors } from '../utils/errors.js';
import { logger } from '../config/logger.js';
import {
  eligibleTenancyFilter,
  isTenancyEligibleForPeriod,
  tenancyStartsAfterDueDay,
} from '../utils/tenancyEligibility.js';

// Billing-plan resolution lives in houseBillingPlan.service.js (shared REGISTRATION /
// CHARGE_PERIOD contexts). Charge generation keeps the prior planLinesForHouse contract.
import {
  planLinesForHouse,
  resolveHouseBillingPlan,
  resolveRegistrationBillingPlan,
  resolveRentDueDayForPeriod,
} from './houseBillingPlan.service.js';

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

async function ensureChargeAndLedger({
  clientId,
  estateId,
  house,
  tenancy,
  period,
  line,
  planMeta,
  estate,
  session,
}) {
  const description = (line.description || line.chargeType || '').trim() || line.chargeType;
  const dueDay = resolveDueDay(house, estate, line.dueDay);
  const amountDueCents = line.amountCents;

  if (!tenancy?._id) {
    throw Errors.InvalidRequest('tenancyId is required for new RentCharges');
  }

  assertTenancyHouseScope({ clientId, estateId, house, tenancy });

  if (!Number.isInteger(amountDueCents) || amountDueCents <= 0) {
    return { charge: null, created: false };
  }

  const expectedIdentity = {
    clientId,
    estateId,
    houseId: house._id,
    tenantId: tenancy.tenantId ?? null,
    tenancyId: tenancy._id,
    period,
    chargeType: line.chargeType,
    description,
  };

  let charge = await RentCharge.findOne({
    tenancyId: tenancy._id,
    period,
    chargeType: line.chargeType,
    description,
  }).session(session);

  let created = false;

  if (charge) {
    assertExistingChargeIdentity(charge, expectedIdentity);
  } else {
    try {
      const [doc] = await RentCharge.create(
        [
          {
            ...expectedIdentity,
            amountDueCents,
            amountPaidCents: 0,
            balanceCents: amountDueCents,
            status: 'UNPAID',
            dueDate: dateUtil.dueDateFor(period, dueDay),
            billingConfigId: line.billingConfigId || null,
            planId: planMeta.planId,
            planVersionId: planMeta.planVersionId || null,
            planVersion: planMeta.planVersion,
            planLineId: line.planLineId || null,
            billingSource: house.billingSource,
            allocationRev: 0,
          },
        ],
        { session }
      );

      charge = doc;
      created = true;
    } catch (error) {
      if (isRentChargeIdentityDuplicate(error)) {
        error.g3RentChargeIdentityConflict = true;
      }
      throw error;
    }
  }

  const { ledgerService } = await import('./ledger.service.js');
  await ledgerService.postEntry(
    {
      clientId,
      estateId,
      houseId: house._id,
      tenantId: tenancy.tenantId || null,
      tenancyId: tenancy._id,
      accountCategory: 'RENT',
      entryType: 'CHARGE',
      amountCents: -Math.abs(charge.amountDueCents),
      referenceType: 'RentCharge',
      referenceId: charge._id,
      description: `${charge.chargeType} ${period}`,
      period,
    },
    { session }
  );

  return { charge, created };
}

export { isTenancyEligibleForPeriod, resolveHouseBillingPlan, resolveRegistrationBillingPlan };

export const rentService = {
  isTenancyEligibleForPeriod,
  resolveHouseBillingPlan,
  resolveRegistrationBillingPlan,

  async generateChargesForEstate(clientId, estateId, period = null) {
    await assertBillingIndexesAligned();
    if (supportsMongoTransactions() !== true) {
      throw Errors.ServiceUnavailable(
        'MongoDB transactions required for charge generation'
      );
    }

    const automaticRun = period == null;
    const billingPeriod = period || dateUtil.currentPeriod();
    const nextPeriod = dateUtil.startOfMonth(billingPeriod).add(1, 'month').format('YYYY-MM');
    const periodStart = dateUtil.startOfMonth(billingPeriod).toDate();
    const afterNextPeriodStart = dateUtil.startOfMonth(billingPeriod).add(2, 'month').toDate();
    const estate = await Estate.findOne({ _id: estateId, clientId }).lean();
    if (!estate) throw Errors.EstateNotFound?.() || Errors.NotFound('Estate not found');

    // The scheduled/default run considers the current cycle and the next cycle.
    // This creates the first full charge for a tenant who joined after this
    // month's rent due date, without inventing a partial-month charge.
    const candidates = await Tenancy.find({
      clientId,
      estateId,
      status: { $in: ['ACTIVE', 'CLOSED'] },
      startAt: { $lt: afterNextPeriodStart },
      $or: [{ endAt: null }, { endAt: { $gt: periodStart } }],
    }).lean();

    let created = 0;
    let eligibleTenancies = 0;
    const excludedTenancyIds = [];
    const tenantIdsForCredit = new Set();
    const chargePeriods = new Set();
    const session = await mongoose.startSession();
    try {
      for (const candidateTenancy of candidates) {
        let committedCreated = 0;
        let committedEligible = false;
        let committedDueCycleExcluded = false;
        let committedPeriod = null;
        await session.withTransaction(async () => {
          const tenancy = await Tenancy.findOne({
            _id: candidateTenancy._id, clientId, estateId,
            status: { $in: ['ACTIVE', 'CLOSED'] },
          }).session(session).lean();
          if (!tenancy) return;

          const lock = await House.updateOne(
            { _id: tenancy.houseId, clientId, estateId, isActive: true },
            { $inc: { billingConfigRev: 1 } },
            { session }
          );
          if (lock.matchedCount !== 1) return;
          const house = await House.findOne({
            _id: tenancy.houseId, clientId, estateId, isActive: true,
          }).session(session).lean();
          if (!house) return;

          const currentPlan = await planLinesForHouse(house, billingPeriod, { session });
          const currentRentLine = currentPlan.lines.find((line) => line.chargeType === 'RENT');
          const currentDueDay = resolveDueDay(
            house, currentPlan.estate || estate, currentRentLine?.dueDay
          );

          let selectedPeriod = billingPeriod;
          let selectedPlan = currentPlan;
          if (!isTenancyEligibleForPeriod(tenancy, billingPeriod, currentDueDay)) {
            // Only the automatic scheduler may move a late joiner's first charge
            // into the next cycle. An explicit historical/month request stays exact.
            if (!automaticRun || !tenancyStartsAfterDueDay(tenancy, billingPeriod, currentDueDay)) {
              committedDueCycleExcluded = true;
              return;
            }

            const nextPlan = await planLinesForHouse(house, nextPeriod, { session });
            const nextRentLine = nextPlan.lines.find((line) => line.chargeType === 'RENT');
            const nextDueDay = resolveDueDay(
              house, nextPlan.estate || estate, nextRentLine?.dueDay
            );
            if (!isTenancyEligibleForPeriod(tenancy, nextPeriod, nextDueDay)) {
              committedDueCycleExcluded = true;
              return;
            }
            selectedPeriod = nextPeriod;
            selectedPlan = nextPlan;
          }

          let attemptCreated = 0;
          for (const line of selectedPlan.lines) {
            if (!line.amountCents || line.amountCents <= 0) continue;
            const result = await ensureChargeAndLedger({
              clientId,
              estateId,
              house,
              tenancy,
              period: selectedPeriod,
              line,
              planMeta: selectedPlan.planMeta,
              estate: selectedPlan.estate || estate,
              session,
            });
            if (result.created) attemptCreated += 1;
          }
          committedCreated = attemptCreated;
          committedEligible = true;
          committedPeriod = selectedPeriod;
        });

        created += committedCreated;
        if (committedEligible) {
          eligibleTenancies += 1;
          chargePeriods.add(committedPeriod);
          if (candidateTenancy.tenantId) tenantIdsForCredit.add(String(candidateTenancy.tenantId));
        } else if (committedDueCycleExcluded) {
          excludedTenancyIds.push(String(candidateTenancy._id));
        }
      }
    } finally {
      session.endSession();
    }

    const orderedChargePeriods = [...chargePeriods].sort();
    const dueCycleExcluded = excludedTenancyIds.length;
    if (created > 0) {
      await audit({
        clientId,
        estateId,
        action: 'BILL_GENERATED',
        resource: 'RentCharge',
        description: `Generated ${created} charges for rent cycle period${orderedChargePeriods.length === 1 ? '' : 's'} ${orderedChargePeriods.join(', ')}`,
        metadata: {
          created,
          period: billingPeriod,
          chargePeriods: orderedChargePeriods,
          eligibleTenancies,
          dueCycleExcluded,
        },
      });
    }

    let creditApplied = 0;
    const creditApplyFailedTenantIds = [];
    for (const tenantId of tenantIdsForCredit) {
      try {
        const r = await autoApplyCredit({
          clientId,
          estateId,
          tenantId: new mongoose.Types.ObjectId(tenantId),
        });
        creditApplied += r.applied || 0;
      } catch (err) {
        creditApplyFailedTenantIds.push(String(tenantId));
        logger.warn({ code: err.code, estateId: String(estateId), tenantId: String(tenantId) }, 'Tenant credit auto-apply skipped');
      }
    }

    return {
      created,
      creditAppliedCents: creditApplied,
      creditApplyFailedTenantIds,
      period: billingPeriod,
      chargePeriods: orderedChargePeriods,
      eligibleTenancies,
      dueCycleExcluded,
      // Retained temporarily for existing API consumers; this now means
      // tenancies excluded from the selected due-day cycle, not proration.
      partialPeriodExcluded: dueCycleExcluded,
      partialPeriodTenancyIds: excludedTenancyIds.slice(0, 20),
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
        { $inc: { billingConfigRev: 1 } },
        { session: ses }
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
      const { lines, planMeta, estate } = await planLinesForHouse(scopedHouse, period, { session: ses });
      const rentLine = lines.find((line) => line.chargeType === 'RENT');
      const dueDay = resolveDueDay(scopedHouse, estate, rentLine?.dueDay);
      if (!isTenancyEligibleForPeriod(currentTenancy, period, dueDay)) {
        throw Errors.InvalidRequest(`Tenancy was not active on ${period}'s configured rent due date; use its first eligible billing cycle.`);
      }
      assertTenancyHouseScope({
        clientId, estateId: scopedHouse.estateId, house: scopedHouse, tenancy: currentTenancy,
      });

      const charges = [];
      for (const line of lines) {
        if (!line.amountCents || line.amountCents <= 0) continue;
        const { charge } = await ensureChargeAndLedger({
          clientId,
          estateId: scopedHouse.estateId,
          house: scopedHouse,
          tenancy: currentTenancy,
          period,
          line,
          planMeta,
          estate,
          session: ses,
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
      await ses.withTransaction(async () => {
        result = await run(ses);
      });
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
      const dueDay = await resolveRentDueDayForPeriod(house, period, { session });
      const eligibility = eligibleTenancyFilter(period, dueDay);
      const matches = eligibility
        ? await Tenancy.find({
          clientId,
          estateId: house.estateId,
          houseId: house._id,
          ...eligibility,
        }).sort({ startAt: -1, _id: -1 }).limit(2).session(session || null).lean()
        : [];
      if (matches.length !== 1) {
        throw Errors.InvalidRequest(
          matches.length > 1
            ? 'More than one tenancy overlaps this rent due date; supply tenancyId explicitly'
            : 'No tenancy overlaps this rent due date; supply a tenancyId for a valid cycle'
        );
      }
      [tenancy] = matches;
    }
    return this.ensureChargesForTenancy(clientId, tenancy, house, period, { session });
  },

  async getOrCreateChargeForHouse(clientId, house, tenant, period, { session, tenancyId = null } = {}) {
    const charges = await this.ensureChargesForHouse(clientId, house, tenant, period, {
      session,
      tenancyId,
    });
    return charges.find((c) => c.chargeType === 'RENT') || charges[0] || null;
  },

  async outstandingChargesForTenancy(clientId, tenancyId, { session } = {}) {
    if (!tenancyId) return [];
    return RentCharge.find({
      clientId,
      tenancyId,
      status: { $in: ['UNPAID', 'PARTIAL', 'OVERPAID'] },
    })
      .session(session || null)
      .sort({ period: 1, chargeType: 1 });
  },

  async outstandingChargesForHouse(clientId, houseId, { session } = {}) {
    return RentCharge.find({
      clientId,
      houseId,
      status: { $in: ['UNPAID', 'PARTIAL', 'OVERPAID'] },
    })
      .session(session || null)
      .sort({ period: 1, chargeType: 1 });
  },

  async previousArrears(clientId, houseId, period) {
    const charges = await RentCharge.find({
      clientId,
      houseId,
      period: { $lt: period },
      status: { $in: ['UNPAID', 'PARTIAL'] },
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
    const requestedPeriod = period || null;
    const p = requestedPeriod || dateUtil.currentPeriod();
    const estateQuery = {
      clientId,
      isActive: true,
      ...estateFilterClause(estateFilter),
    };
    if (estateId) estateQuery._id = estateId;

    const estates = await Estate.find(estateQuery).lean();
    let created = 0;
    const results = [];
    for (const estate of estates) {
      const r = await this.generateChargesForEstate(clientId, estate._id, requestedPeriod);
      created += r.created || 0;
      results.push({
        estateId: estate._id,
        name: estate.name,
        created: r.created,
        period: r.period,
        eligibleTenancies: r.eligibleTenancies,
        chargePeriods: r.chargePeriods,
        dueCycleExcluded: r.dueCycleExcluded,
        partialPeriodExcluded: r.partialPeriodExcluded,
      });
    }
    return { period: p, chargePeriods: [...new Set(results.flatMap((r) => r.chargePeriods || []))].sort(), created, estates: results };
  },

  async houseAccount(clientId, houseId, estateFilter = null) {
    const house = await House.findOne({
      _id: houseId,
      clientId,
      ...estateFilterClause(estateFilter),
    }).lean();
    if (!house) throw Errors.HouseNotFound();

    const estate = await Estate.findById(house.estateId).lean();
    const period = dateUtil.currentPeriod();
    const configs = await HouseBillingConfig.find({ clientId, houseId }).lean();
    const charges = await RentCharge.find({ clientId, houseId }).sort({ period: -1 }).lean();
    const { Payment } = await import('../models/Payment.js');
    const payments = await Payment.find({ clientId, houseId, status: 'CONFIRMED' })
      .sort({ paymentDate: -1 })
      .limit(100)
      .lean();

    const { ledgerService } = await import('./ledger.service.js');

    const currentTenancy = await Tenancy.findOne({
      clientId,
      houseId,
      status: 'ACTIVE',
    }).lean();

    let currentTenancyBalanceCents = null;
    let currentTenancyHistoricalCoverage = 'UNVERIFIED';
    let currentTenancyBalanceVerified = false;
    let historicalUnattributedCents = 0;
    if (currentTenancy) {
      const bal = await ledgerService.balanceForTenancy(clientId, currentTenancy._id, 'RENT');
      currentTenancyBalanceCents = Number.isSafeInteger(bal?.knownArrearsCents)
        ? bal.knownArrearsCents
        : null;
      currentTenancyHistoricalCoverage = bal?.historicalCoverage ?? 'UNVERIFIED';
      currentTenancyBalanceVerified = bal?.verifiedFullObligation === true;
    }
    const unattrCharges = charges.filter((c) => !c.tenancyId);
    for (const c of unattrCharges) {
      historicalUnattributedCents += Math.max(c.balanceCents || 0, 0);
    }

    const currentCharges = charges.filter((c) => c.period === period);
    let billedCents = 0;
    let paidFromChargesCents = 0;
    let overdueCents = 0;
    const byPeriod = new Map();

    for (const c of charges) {
      billedCents += c.amountDueCents || 0;
      paidFromChargesCents += c.amountPaidCents || 0;
      const bal = c.balanceCents || 0;
      if (c.period < period && bal > 0) overdueCents += bal;

      const key = c.period;
      const row = byPeriod.get(key) || {
        period: key,
        billedCents: 0,
        paidCents: 0,
        outstandingCents: 0,
        status: 'PAID',
        charges: [],
        byTenancy: {},
      };
      row.billedCents += c.amountDueCents || 0;
      row.paidCents += c.amountPaidCents || 0;
      row.outstandingCents += bal;
      const tid = c.tenancyId ? String(c.tenancyId) : 'unattributed';
      row.byTenancy[tid] = (row.byTenancy[tid] || 0) + bal;
      row.charges.push({
        chargeType: c.chargeType,
        description: c.description,
        amountDueCents: c.amountDueCents,
        amountPaidCents: c.amountPaidCents,
        balanceCents: c.balanceCents,
        status: c.status,
        dueDate: c.dueDate,
        tenancyId: c.tenancyId || null,
      });
      byPeriod.set(key, row);
    }

    const ledgerBal = await ledgerService.balanceForHouse(clientId, houseId);
    const paidFromLedger = await ledgerService.totalPaymentsReceived(clientId, { houseId });
    const paidCents = paidFromLedger > 0 ? paidFromLedger : paidFromChargesCents;
    const houseKnownArrearsCents = Number.isSafeInteger(ledgerBal?.knownArrearsCents)
      ? ledgerBal.knownArrearsCents
      : null;
    const houseWideOutstanding = houseKnownArrearsCents;
    const ledgerHistory = await ledgerService.historyForHouse(clientId, houseId, { limit: 50 });

    return {
      house: {
        _id: house._id,
        houseNumber: house.houseNumber,
        estateId: house.estateId,
        status: house.status,
        monthlyRent: house.monthlyRent,
        dueDay: house.dueDay,
        houseTypeId: house.houseTypeId || null,
      },
      estate: estate ? { _id: estate._id, name: estate.name } : null,
      period,
      billingConfigs: configs,
      currentCharges,
      payments,
      ledger: ledgerHistory,
      currentTenancyId: currentTenancy?._id || null,
      totals: {
        billedCents,
        paidCents,
        outstandingCents: houseWideOutstanding,
        knownArrearsCents: houseKnownArrearsCents,
        historicalCoverage: ledgerBal?.historicalCoverage ?? 'UNVERIFIED',
        verifiedFullObligation: ledgerBal?.verifiedFullObligation === true,
        overdueCents,
        currentTenancyBalanceCents,
        currentTenancyHistoricalCoverage,
        currentTenancyBalanceVerified,
        historicalUnattributedCents,
        balanceSource: ledgerBal?.source || 'unavailable',
        note:
          'outstandingCents is house-wide historical projection; currentTenancyBalanceCents is the active occupancy only',
      },
      monthly: [...byPeriod.values()].sort((a, b) => (a.period < b.period ? 1 : -1)),
    };
  },

  unpaidHouseholds: (clientId, estateFilter, period = dateUtil.currentPeriod()) =>
    RentCharge.find({
      clientId,
      ...estateFilterClause(estateFilter),
      period,
      status: { $in: ['UNPAID', 'PARTIAL'] },
    })
      .populate('houseId')
      .populate('tenantId'),

  async summary(clientId, estateFilter, period = dateUtil.currentPeriod()) {
    const filter = { clientId, period, ...estateFilterClause(estateFilter) };
    const charges = await RentCharge.find(filter);
    const summary = {
      totalHouseholds: new Set(charges.map((c) => String(c.houseId))).size,
      paid: 0,
      partial: 0,
      unpaid: 0,
      expectedCents: 0,
      collectedCents: 0,
      byChargeType: {},
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
        houseStatus.set(
          hid,
          c.status === 'PARTIAL' && prev === 'PAID'
            ? 'PARTIAL'
            : c.status === 'UNPAID'
              ? 'UNPAID'
              : prev
        );
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
