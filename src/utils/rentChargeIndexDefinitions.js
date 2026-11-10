import { RENT_CHARGE_INDEX } from '../models/RentCharge.js';

export const LEGACY_HOUSE_UNIQUE_KEYS = Object.freeze({
  clientId: 1,
  houseId: 1,
  period: 1,
  chargeType: 1,
  description: 1,
});

export const TARGET_PARTIAL_FILTER = Object.freeze({
  tenancyId: Object.freeze({ $type: 'objectId' }),
});

function sameOrderedKeyPattern(actual, expected) {
  if (!actual || typeof actual !== 'object' || Array.isArray(actual)) return false;
  const a = Object.entries(actual);
  const e = Object.entries(expected);

  return a.length === e.length && e.every(([key, direction], i) =>
    a[i]?.[0] === key && a[i]?.[1] === direction
  );
}

function canonicalize(value) {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.keys(value).sort().map((key) => [key, canonicalize(value[key])])
    );
  }
  return value;
}

function sameExpression(actual, expected) {
  return JSON.stringify(canonicalize(actual)) === JSON.stringify(canonicalize(expected));
}

function hasSafeUniqueOptions(index) {
  return index?.unique === true
    && index?.sparse !== true
    && index?.collation == null
    && index?.expireAfterSeconds == null;
}

function sameFieldSet(actual, expected) {
  if (!actual || typeof actual !== 'object' || Array.isArray(actual)) return false;
  const a = Object.keys(actual).sort();
  const e = Object.keys(expected).sort();
  return a.length === e.length && a.every((key, i) => key === e[i]);
}

export function isExactTargetRentChargeIndex(index) {
  return index?.name === RENT_CHARGE_INDEX.TARGET_UNIQUE
    && hasSafeUniqueOptions(index)
    && sameOrderedKeyPattern(index.key, RENT_CHARGE_INDEX.TARGET_KEYS)
    && sameExpression(index.partialFilterExpression, TARGET_PARTIAL_FILTER);
}

export function isExactObsoleteHouseRentChargeIndex(index) {
  return index?.name === RENT_CHARGE_INDEX.OBSOLETE_HOUSE_UNIQUE
    && hasSafeUniqueOptions(index)
    && sameOrderedKeyPattern(index.key, LEGACY_HOUSE_UNIQUE_KEYS)
    && index.partialFilterExpression == null;
}

function isHouseUniqueCandidate(index) {
  if (index?.name === RENT_CHARGE_INDEX.OBSOLETE_HOUSE_UNIQUE) return true;
  if (index?.unique !== true) return false;

  // Any unexplained unique RentCharge index containing houseId can impose
  // house-scoped restrictions that conflict with successive Tenancies.
  return Object.hasOwn(index.key || {}, 'houseId');
}

function isTargetCandidate(index) {
  return index?.name === RENT_CHARGE_INDEX.TARGET_UNIQUE
    || (index?.unique === true && sameFieldSet(index.key, RENT_CHARGE_INDEX.TARGET_KEYS));
}

/**
 * Only the exact, historically verified House index is eligible for removal.
 * Other House-scoped unique indexes are suspicious and block readiness.
 */
export function assessRentChargeIndexes(indexes = []) {
  const list = Array.isArray(indexes) ? indexes : [];
  const exactTarget = list.filter(isExactTargetRentChargeIndex);
  const targetConflicts = list
    .filter(isTargetCandidate)
    .filter((index) => !isExactTargetRentChargeIndex(index));

  const houseCandidates = list.filter(isHouseUniqueCandidate);
  const exactObsolete = houseCandidates.filter(isExactObsoleteHouseRentChargeIndex);
  const suspiciousHouseUnique = houseCandidates
    .filter((index) => !isExactObsoleteHouseRentChargeIndex(index));

  return {
    hasExactTarget: exactTarget.length > 0,
    exactTargetIndexes: exactTarget,
    exactObsoleteIndexes: exactObsolete,
    suspiciousHouseUniqueIndexes: suspiciousHouseUnique,
    targetConflicts,
    hasAnyHouseUnique: houseCandidates.length > 0,
  };
}
