import mongoose from 'mongoose';
import { assessRentChargeIndexes } from './rentChargeIndexDefinitions.js';

let lastReport = null;

/** Read-only inspection of live RentCharge identity indexes. */
export async function inspectRentChargeIndexes() {
  if (!mongoose.connection?.db) {
    lastReport = {
      ok: false,
      aligned: false,
      reason: 'no_database_connection',
      indexes: [],
      hasTargetUnique: false,
      hasHouseScopedUniqueConstraint: false,
      inspectedAt: new Date().toISOString(),
    };
    return lastReport;
  }

  const coll = mongoose.connection.db.collection('rentcharges');
  let indexes;

  try {
    indexes = await coll.listIndexes().toArray();
  } catch (err) {
    if (err?.codeName === 'NamespaceNotFound' || /not found/i.test(err?.message || '')) {
      indexes = [];
    } else {
      lastReport = {
        ok: false,
        aligned: false,
        reason: `listIndexes_failed: ${err.message}`,
        indexes: [],
        hasTargetUnique: false,
        hasHouseScopedUniqueConstraint: false,
        inspectedAt: new Date().toISOString(),
      };
      return lastReport;
    }
  }

  const assessment = assessRentChargeIndexes(indexes);
  const hasTargetUnique = assessment.hasExactTarget;
  const hasHouseScopedUniqueConstraint = assessment.hasAnyHouseUnique;

  const aligned = hasTargetUnique
    && !hasHouseScopedUniqueConstraint
    && assessment.targetConflicts.length === 0;

  let reason = 'aligned';
  if (assessment.targetConflicts.length) reason = 'target_index_definition_conflict';
  else if (assessment.suspiciousHouseUniqueIndexes.length) reason = 'unrecognized_house_unique_index';
  else if (assessment.exactObsoleteIndexes.length) reason = 'obsolete_house_unique_present';
  else if (!hasTargetUnique) reason = 'target_unique_missing';

  lastReport = {
    ok: true,
    aligned,
    reason,
    hasTargetUnique,
    hasHouseScopedUniqueConstraint,
    targetConflicts: assessment.targetConflicts.map((i) => i.name),
    exactObsoleteHouseUniques: assessment.exactObsoleteIndexes.map((i) => i.name),
    suspiciousHouseUniques: assessment.suspiciousHouseUniqueIndexes.map((i) => ({
      name: i.name,
      key: i.key,
      unique: Boolean(i.unique),
      partialFilterExpression: i.partialFilterExpression || null,
    })),
    indexes: indexes.map((i) => ({
      name: i.name,
      key: i.key,
      unique: Boolean(i.unique),
      partialFilterExpression: i.partialFilterExpression || null,
      sparse: Boolean(i.sparse),
      collation: i.collation || null,
      hidden: Boolean(i.hidden),
    })),
    inspectedAt: new Date().toISOString(),
  };

  return lastReport;
}

export function getBillingIndexReport() {
  return lastReport;
}

export function areBillingIndexesAligned() {
  return Boolean(lastReport?.aligned);
}

export async function refreshBillingIndexReadiness() {
  const report = await inspectRentChargeIndexes();
  return report.aligned;
}

export async function assertBillingIndexesAligned() {
  const report = await inspectRentChargeIndexes();

  if (!report.aligned) {
    const err = new Error(
      `RentCharge identity indexes not aligned (${report.reason}). `
        + 'Resolve the index migration before generating charges or posting financial transactions.'
    );
    err.code = 'BILLING_INDEXES_MISALIGNED';
    err.report = report;
    throw err;
  }

  return report;
}

/** Test helper only. */
export function _setBillingIndexReportForTests(report) {
  lastReport = report;
}
