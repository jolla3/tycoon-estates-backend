// src/services/houseBillingPlan.service.js
// Shared House billing-plan resolution for charge generation and registration snapshots.
// Explicit contexts only: REGISTRATION (registrationAt) and CHARGE_PERIOD (period).

import { Estate } from '../models/Estate.js';
import { HouseBillingConfig } from '../models/HouseBillingConfig.js';
import { HouseType, assertUniquePlanLines } from '../models/HouseType.js';
import { HouseTypePlanVersion } from '../models/HouseTypePlanVersion.js';
import { resolveHouseTypePlanVersion } from './houseTypePlanVersion.service.js';
import { dateUtil } from '../utils/date.js';
import { money } from '../utils/money.js';
import { Errors } from '../utils/errors.js';

function resolveDueDay(house, estate, configDueDay) {
  if (configDueDay != null) return configDueDay;
  if (house?.dueDay != null) return house.dueDay;
  if (estate?.defaultDueDay != null) return estate.defaultDueDay;
  return 5;
}

/**
 * Shared House billing-plan resolution.
 *
 * Contexts (explicit; never overload a period string for both):
 * - { kind: 'CHARGE_PERIOD', period }  — monthly generation (period-start for HOUSE_CONFIG)
 * - { kind: 'REGISTRATION', registrationAt } — informational snapshot at one captured instant
 *
 * Outcomes are discriminated. An empty lines array is not the same as UNCONFIGURED
 * or a missing effective plan. Charge generation continues to skip non-positive lines.
 *
 * HOUSE_TYPE charge resolution retains billingPlanRev write fencing via
 * resolveHouseTypePlanVersion. Registration uses a pure read of the same period rule.
 */
async function resolveHouseBillingPlan(house, context, { session } = {}) {
  if (!house?._id) throw Errors.InvalidRequest('House is required for billing plan resolution');
  if (!context || typeof context !== 'object' || !context.kind) {
    throw Errors.InvalidRequest('Billing plan context must be { kind: REGISTRATION|CHARGE_PERIOD, ... }');
  }

  const estateQuery = Estate.findOne({ _id: house.estateId, clientId: house.clientId });
  if (session) estateQuery.session(session);
  const estate = await estateQuery.lean();
  if (!estate) throw Errors.Conflict('House Estate ownership could not be verified for billing');

  const declaredSource = house.billingSource || 'LEGACY_UNCLASSIFIED';
  // Registration compatibility: a legacy House with an explicit HouseType FK
  // has an unambiguous billing-plan source. Keep charge generation's existing
  // fail-closed treatment of LEGACY_UNCLASSIFIED unchanged.
  const source = context.kind === 'REGISTRATION'
    && declaredSource === 'LEGACY_UNCLASSIFIED'
    && house.houseTypeId
    ? 'HOUSE_TYPE'
    : declaredSource;
  const emptyMeta = { planId: null, planVersionId: null, planVersion: null };
  const base = { estate, source, planMeta: emptyMeta };

  if (source === 'UNCONFIGURED') {
    return { ...base, lines: [], outcome: 'UNCONFIGURED' };
  }
  if (source === 'LEGACY_UNCLASSIFIED') {
    if (context.kind === 'REGISTRATION') {
      return { ...base, lines: [], outcome: 'LEGACY_UNCLASSIFIED' };
    }
    throw Errors.Conflict(`House ${house._id} has unclassified legacy billing source; generation is blocked.`);
  }

  if (source === 'HOUSE_TYPE') {
    if (!house.houseTypeId) {
      if (context.kind === 'REGISTRATION') {
        return { ...base, lines: [], outcome: 'NO_EFFECTIVE_HOUSE_TYPE_VERSION' };
      }
      throw Errors.Conflict('HOUSE_TYPE billing requires houseTypeId');
    }
    const typeQuery = HouseType.findOne({
      _id: house.houseTypeId, clientId: house.clientId, estateId: house.estateId,
    });
    if (session) typeQuery.session(session);
    const type = await typeQuery.lean();
    if (!type) {
      throw Errors.Conflict('HouseType does not belong to this House Estate');
    }

    let period;
    if (context.kind === 'REGISTRATION') {
      if (!(context.registrationAt instanceof Date) || !Number.isFinite(context.registrationAt.getTime())) {
        throw Errors.InvalidRequest('registrationAt must be a valid Date');
      }
      period = dateUtil.periodOf(context.registrationAt);
    } else if (context.kind === 'CHARGE_PERIOD') {
      period = context.period;
    } else {
      throw Errors.InvalidRequest(`Unsupported billing plan context kind: ${context.kind}`);
    }

    let version = null;
    if (context.kind === 'CHARGE_PERIOD') {
      // Charge generation: acquire the shared billingPlanRev write fence.
      version = await resolveHouseTypePlanVersion({
        clientId: house.clientId, estateId: house.estateId, houseTypeId: type._id, period, session,
      });
    } else {
      // Registration: pure read of the same period-effective rule (no write fence).
      const q = HouseTypePlanVersion.findOne({
        clientId: house.clientId, estateId: house.estateId, houseTypeId: type._id,
        effectiveFromPeriod: { $lte: period },
      }).sort({ effectiveFromPeriod: -1, version: -1 });
      if (session) q.session(session);
      version = await q.lean();
    }

    if (!version && context.kind === 'REGISTRATION') {
      // Older HouseTypes can predate immutable plan-version history. Their
      // defaultBilling array is still the canonical configured recurring plan.
      // Use it only when there are NO history records at all. If history exists
      // but starts in a future period, do not expose the future plan early.
      const historyQuery = HouseTypePlanVersion.findOne({
        clientId: house.clientId, estateId: house.estateId, houseTypeId: type._id,
      }).select('_id');
      if (session) historyQuery.session(session);
      const hasAnyHistory = await historyQuery.lean();

      if (!hasAnyHistory) {
        if (!Array.isArray(type.defaultBilling)) {
          throw Errors.Conflict('HouseType default billing is missing');
        }
        const lines = type.defaultBilling.map((line) => {
          if (!['RENT', 'WATER', 'ELECTRICITY', 'OTHER'].includes(line.chargeType)
            || !Number.isSafeInteger(line.amountCents)
            || line.amountCents < 0) {
            throw Errors.Conflict('HouseType default billing contains an invalid line');
          }
          return {
            chargeType: line.chargeType,
            description: String(line.description || line.chargeType || '').trim(),
            amountCents: line.amountCents,
            dueDay: line.dueDay,
            planLineId: line.lineId || null,
          };
        });
        assertUniquePlanLines(lines);
        return {
          ...base,
          lines,
          planMeta: {
            ...emptyMeta,
            planId: type._id,
            planVersion: Number.isSafeInteger(type.planVersion) ? type.planVersion : null,
          },
          outcome: lines.length === 0 ? 'VALID_EMPTY_HOUSE_TYPE_PLAN' : 'OK',
        };
      }
    }

    if (!version) {
      return {
        ...base,
        lines: [],
        planMeta: { ...emptyMeta, planId: type._id },
        outcome: 'NO_EFFECTIVE_HOUSE_TYPE_VERSION',
      };
    }
    const lines = (version.lines || []).map((line) => ({
      chargeType: line.chargeType,
      description: String(line.description || line.chargeType || '').trim(),
      amountCents: line.amountCents,
      dueDay: line.dueDay,
      planLineId: line.lineId,
    }));
    assertUniquePlanLines(lines);
    return {
      ...base,
      lines,
      planMeta: { planId: type._id, planVersionId: version._id, planVersion: version.version },
      outcome: lines.length === 0 ? 'VALID_EMPTY_HOUSE_TYPE_PLAN' : 'OK',
    };
  }

  if (source === 'HOUSE_CONFIG') {
    let at;
    if (context.kind === 'REGISTRATION') {
      if (!(context.registrationAt instanceof Date) || !Number.isFinite(context.registrationAt.getTime())) {
        throw Errors.InvalidRequest('registrationAt must be a valid Date');
      }
      at = context.registrationAt;
    } else if (context.kind === 'CHARGE_PERIOD') {
      at = dateUtil.startOfMonth(context.period).toDate();
    } else {
      throw Errors.InvalidRequest(`Unsupported billing plan context kind: ${context.kind}`);
    }

    // Inclusive effectiveFrom, exclusive effectiveTo; preserve active/retired row semantics.
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

    if (lines.length === 0 && context.kind === 'REGISTRATION') {
      // Distinguish no effective rows from explicit UNCONFIGURED. Also note future-only configs.
      const futureQuery = HouseBillingConfig.find({
        clientId: house.clientId, estateId: house.estateId, houseId: house._id,
        effectiveFrom: { $gt: at },
      }).select('_id').limit(1);
      if (session) futureQuery.session(session);
      const future = await futureQuery.lean();
      return {
        ...base,
        lines: [],
        outcome: future.length ? 'HOUSE_CONFIG_FUTURE_ONLY' : 'HOUSE_CONFIG_NO_EFFECTIVE_ROWS',
      };
    }

    return { ...base, lines, outcome: 'OK' };
  }

  if (source === 'MONTHLY_RENT') {
    const amountCents = money.toCents(house.monthlyRent);
    // Zero monthly rent is still a selected MONTHLY_RENT source (configured zero).
    const lines = [{
      chargeType: 'RENT',
      description: 'Rent',
      amountCents: Number.isSafeInteger(amountCents) ? amountCents : 0,
      dueDay: house.dueDay,
      planLineId: `MONTHLY_RENT:${house._id}`,
    }];
    // Charge generation historically skipped non-positive lines; keep that for CHARGE_PERIOD.
    const genLines = amountCents > 0 ? lines : [];
    return {
      ...base,
      lines: context.kind === 'REGISTRATION' ? lines : genLines,
      outcome: 'OK',
    };
  }

  throw Errors.InvalidRequest(`Unsupported House billing source: ${source}`);
}

/** Charge-generation adapter: period-based resolution (preserves prior planLinesForHouse contract). */
async function planLinesForHouse(house, period, { session } = {}) {
  const resolved = await resolveHouseBillingPlan(
    house,
    { kind: 'CHARGE_PERIOD', period },
    { session },
  );
  return {
    lines: resolved.lines,
    planMeta: resolved.planMeta,
    estate: resolved.estate,
    source: resolved.source,
  };
}

/**
 * Read the effective rent-cycle due day for a House/period without acquiring the
 * charge-generation write fence. Charge creation re-resolves and validates the
 * same plan inside its transaction before committing any RentCharge.
 */
async function resolveRentDueDayForPeriod(house, period, { session } = {}) {
  const snapshot = await resolveRegistrationBillingPlan(
    house,
    dateUtil.startOfMonth(period).toDate(),
    { session },
  );
  const rentLine = (snapshot.lines || []).find((line) => line.chargeType === 'RENT');
  return rentLine?.dueDay ?? resolveDueDay(house, snapshot.estate, null);
}

/**
 * Registration snapshot: informational House plan at one captured registrationAt.
 * Never generates RentCharges. Returns structured outcome + display lines with due-day policy.
 */
async function resolveRegistrationBillingPlan(house, registrationAt, { session } = {}) {
  const resolved = await resolveHouseBillingPlan(
    house,
    { kind: 'REGISTRATION', registrationAt },
    { session },
  );
  const lines = (resolved.lines || []).map((line) => {
    const dueDay = resolveDueDay(house, resolved.estate, line.dueDay);
    return {
      chargeType: line.chargeType,
      description: line.description,
      amountCents: line.amountCents,
      dueDay,
      planLineId: line.planLineId || null,
    };
  });
  return {
    outcome: resolved.outcome,
    source: resolved.source,
    lines,
    estate: resolved.estate,
    planMeta: resolved.planMeta,
    registrationAt,
  };
}


export {
  resolveHouseBillingPlan,
  planLinesForHouse,
  resolveRegistrationBillingPlan,
  resolveRentDueDayForPeriod,
  resolveDueDay,
};
