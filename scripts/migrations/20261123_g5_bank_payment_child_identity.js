/**
 * G5 — Allow one Bank receipt-origin Payment child per destination Tenancy.
 *
 * Default is a read-only dry-run. --execute requires the G5 migration guard's
 * allowlisted database and host. This migration creates and verifies the new
 * compound unique index BEFORE dropping the legacy single-field unique index.
 * If creation fails, the old index remains in place.
 *
 * This is a forward-only contract after the first receipt creates multiple
 * destination-tenancy children. A downgrade to the legacy one-Payment-per-
 * receipt code/index is not safe once such a receipt exists. Keep the new
 * index and reader/writer contract; rollback requires an audited data plan.
 *
 * Do not run against production or any live financial database as part of the
 * audited-corrections implementation task.
 */
import mongoose from 'mongoose';
import { isDeepStrictEqual } from 'node:util';
import { assertSafeTarget, dupGroups } from './lib/g5MigrationGuard.js';
import { BANK_PAYMENT_CHILD_INDEX as CHILD, BANK_CREDIT_MOVEMENT_INDEX as MOVEMENT, evaluateBankPaymentIndexes, evaluateBankCreditMovementIndexes } from '../../src/utils/bankPaymentIndexReadiness.js';

const COLLECTION = 'payments';
const RECEIPTS = 'banktransactions';
const TENANCIES = 'tenancies';
const targetSpec = {
  collection: COLLECTION,
  name: CHILD.name,
  key: CHILD.key,
  unique: true,
  partialFilterExpression: CHILD.partialFilterExpression,
};
const MOVEMENT_INDEX = {
  collection: 'tenantcreditmovements',
  name: MOVEMENT.name,
  key: MOVEMENT.key,
  unique: false,
  partialFilterExpression: MOVEMENT.partialFilterExpression,
};
const sameKey = (a, b) => {
  const left = Object.entries(a || {});
  const right = Object.entries(b || {});
  return left.length === right.length
    && left.every(([key, value], index) =>
      key === right[index][0] && isDeepStrictEqual(value, right[index][1])
    );
};
const samePartial = (a, b) => isDeepStrictEqual(a || null, b || null);
function findIndexExact(indexes, spec) {
  return indexes.find((index) =>
    index.name === spec.name
    && sameKey(index.key, spec.key)
    && Boolean(index.unique) === Boolean(spec.unique)
    && Boolean(index.sparse) === Boolean(spec.sparse)
    && samePartial(index.partialFilterExpression, spec.partialFilterExpression)
  );
}

async function rows(collection, filter, projection = { _id: 1 }) {
  return mongoose.connection.db.collection(collection)
    .find(filter, { projection }).limit(20).toArray();
}

async function preflight(db) {
  const payments = db.collection(COLLECTION);
  const bankChildrenMissingReceipt = await rows(COLLECTION, {
    origin: 'BANK',
    $or: [{ bankTransactionId: null }, { bankTransactionId: { $exists: false } }],
  }, { _id: 1, clientId: 1, estateId: 1, tenantId: 1, tenancyId: 1 });
  const nonBankRowsWithBankReceiptLink = await rows(COLLECTION, {
    bankTransactionId: { $type: 'objectId' },
    origin: { $ne: 'BANK' },
  }, { _id: 1, origin: 1, bankTransactionId: 1 });
  const missingDestination = await rows(COLLECTION, {
    origin: 'BANK',
    bankTransactionId: { $type: 'objectId' },
    $or: [{ tenancyId: null }, { tenancyId: { $exists: false } }],
  }, { _id: 1, bankTransactionId: 1, clientId: 1, estateId: 1, tenantId: 1 });
  const duplicateChildren = await dupGroups(
    db,
    COLLECTION,
    { origin: 'BANK', bankTransactionId: { $type: 'objectId' }, tenancyId: { $type: 'objectId' } },
    { receipt: '$bankTransactionId', tenancy: '$tenancyId' },
  );
  const orphanReceipts = await payments.aggregate([
    { $match: { origin: 'BANK', bankTransactionId: { $type: 'objectId' } } },
    { $lookup: { from: RECEIPTS, localField: 'bankTransactionId', foreignField: '_id', as: 'receipt' } },
    { $match: { receipt: { $size: 0 } } },
    { $project: { _id: 1, bankTransactionId: 1 } },
    { $limit: 20 },
  ]).toArray();
  const sourceScopeMismatch = await payments.aggregate([
    { $match: { origin: 'BANK', bankTransactionId: { $type: 'objectId' } } },
    { $lookup: { from: RECEIPTS, localField: 'bankTransactionId', foreignField: '_id', as: 'receipt' } },
    { $unwind: { path: '$receipt', preserveNullAndEmptyArrays: true } },
    { $lookup: { from: TENANCIES, localField: 'receipt.matchedTenancyId', foreignField: '_id', as: 'source' } },
    { $unwind: { path: '$source', preserveNullAndEmptyArrays: true } },
    { $match: { $expr: { $or: [
      { $eq: ['$receipt._id', null] },
      { $ne: ['$clientId', '$receipt.clientId'] },
      { $ne: ['$estateId', '$receipt.estateId'] },
      { $ne: ['$tenantId', '$receipt.matchedTenantId'] },
      { $ne: ['$receipt.eventType', 'CREDIT'] },
      { $ne: ['$receipt.processingState', 'POSTED'] },
      { $ne: ['$receipt.matchStatus', 'MATCHED'] },
      { $eq: ['$source._id', null] },
      { $ne: ['$receipt.matchedHouseId', '$source.houseId'] },
      { $ne: ['$receipt.matchedTenantId', '$source.tenantId'] },
      { $ne: ['$receipt.clientId', '$source.clientId'] },
      { $ne: ['$receipt.estateId', '$source.estateId'] },
      { $gt: ['$source.startAt', '$receipt.transactionDate'] },
      { $and: [
        { $ne: ['$source.endAt', null] },
        { $lte: ['$source.endAt', '$receipt.transactionDate'] },
      ] },
      { $not: [{ $in: ['$source.status', ['ACTIVE', 'CLOSED']] }] },
    ] } } },
    { $project: { _id: 1, bankTransactionId: 1, clientId: 1, estateId: 1, tenantId: 1,
      receiptClientId: '$receipt.clientId', receiptEstateId: '$receipt.estateId',
      receiptTenantId: '$receipt.matchedTenantId', sourceTenancyId: '$receipt.matchedTenancyId' } },
    { $limit: 20 },
  ]).toArray();
  const destinationScopeMismatch = await payments.aggregate([
    { $match: { origin: 'BANK', bankTransactionId: { $type: 'objectId' } } },
    { $lookup: { from: TENANCIES, localField: 'tenancyId', foreignField: '_id', as: 'destination' } },
    { $unwind: { path: '$destination', preserveNullAndEmptyArrays: true } },
    { $lookup: { from: 'houses', localField: 'houseId', foreignField: '_id', as: 'paymentHouse' } },
    { $unwind: { path: '$paymentHouse', preserveNullAndEmptyArrays: true } },
    { $match: { $expr: { $or: [
      { $eq: ['$destination._id', null] },
      { $ne: ['$clientId', '$destination.clientId'] },
      { $ne: ['$estateId', '$destination.estateId'] },
      { $ne: ['$tenantId', '$destination.tenantId'] },
      { $not: [{ $in: ['$destination.status', ['ACTIVE', 'CLOSED']] }] },
      { $ne: ['$houseId', '$destination.houseId'] },
      { $eq: ['$paymentHouse._id', null] },
      { $ne: ['$houseId', '$paymentHouse._id'] },
      { $ne: ['$paymentHouse.clientId', '$clientId'] },
      { $ne: ['$paymentHouse.estateId', '$estateId'] },
    ] } } },
    { $project: { _id: 1, bankTransactionId: 1, tenancyId: 1, clientId: 1, estateId: 1, tenantId: 1, houseId: 1,
      destinationClientId: '$destination.clientId', destinationEstateId: '$destination.estateId',
      destinationTenantId: '$destination.tenantId', destinationHouseId: '$destination.houseId' } },
    { $limit: 20 },
  ]).toArray();

  return [
    { check: 'bank_payment_missing_canonical_receipt', samples: bankChildrenMissingReceipt },
    { check: 'non_bank_payment_with_bank_receipt_link', samples: nonBankRowsWithBankReceiptLink },
    { check: 'missing_destination_tenancy', samples: missingDestination },
    { check: 'duplicate_receipt_destination_child', samples: duplicateChildren },
    { check: 'orphan_bank_receipt_reference', samples: orphanReceipts },
    { check: 'bank_receipt_source_scope_mismatch', samples: sourceScopeMismatch },
    { check: 'bank_child_destination_scope_mismatch', samples: destinationScopeMismatch },
  ];
}

export async function runBankPaymentChildIdentityMigration({ argv = process.argv, uri = process.env.MONGODB_URI } = {}) {
  const execute = argv.includes('--execute');
  const target = assertSafeTarget(uri, execute);
  console.log(JSON.stringify({ migration: 'g5_bank_payment_child_identity', phase: 'preflight', dbName: target.dbName, execute }));
  await mongoose.connect(uri);
  try {
    const db = mongoose.connection.db;
    const checks = await preflight(db);
    const blocking = checks.filter((check) => check.samples.length > 0);
    if (blocking.length) {
      console.error(JSON.stringify({ status: 'blocked', checks: blocking }));
      process.exitCode = 2;
      return { status: 'blocked', blocking };
    }

    const collection = db.collection(COLLECTION);
    const existing = await collection.listIndexes().toArray();
    const movementCollection = db.collection(MOVEMENT_INDEX.collection);
    const movementIndexes = await movementCollection.listIndexes().toArray();
    const targetExists = Boolean(findIndexExact(existing, targetSpec));
    const movementIndexExists = Boolean(findIndexExact(movementIndexes, MOVEMENT_INDEX));
    const unsupportedUnique = existing.filter((index) =>
      index.unique === true
      && index.name !== CHILD.name
      && Object.keys(index.key || {}).includes('bankTransactionId')
      && !sameKey(index.key, { bankTransactionId: 1 })
    );
    if (unsupportedUnique.length) {
      const result = {
        status: 'blocked',
        reason: 'Unrecognized unique index contains bankTransactionId; manual schema/index review is required',
        indexes: unsupportedUnique.map((index) => ({ name: index.name, key: index.key })),
      };
      console.error(JSON.stringify(result));
      process.exitCode = 2;
      return result;
    }
    const legacy = existing.filter((index) =>
      index.unique === true && sameKey(index.key, { bankTransactionId: 1 })
    );
    const plan = [
      ...(targetExists ? [] : [{ op: 'create', collection: COLLECTION, name: CHILD.name, key: CHILD.key }]),
      ...(movementIndexExists ? [] : [{ op: 'create', collection: MOVEMENT_INDEX.collection, name: MOVEMENT_INDEX.name, key: MOVEMENT_INDEX.key }]),
      ...legacy.map((index) => ({ op: 'drop_after_verified_create', collection: COLLECTION, name: index.name })),
    ];
    console.log(JSON.stringify({
      plan,
      mode: execute ? 'execute' : 'dry_run',
      rollback: 'forward_only_after_multi_tenancy_bank_receipt; do_not_restore_legacy_unique_bankTransactionId_index',
    }));
    if (!execute) return { status: 'dry_run', plan, checks };

    // Make the replacement safe first. Never remove legacy uniqueness before
    // the stronger receipt+destination identity is present and verified.
    if (!findIndexExact(await collection.listIndexes().toArray(), targetSpec)) {
      await collection.createIndex(CHILD.key, {
        name: CHILD.name,
        unique: true,
        partialFilterExpression: CHILD.partialFilterExpression,
      });
    }
    if (!findIndexExact(await collection.listIndexes().toArray(), targetSpec)) {
      throw new Error('New Bank child identity index could not be verified; legacy index was retained');
    }
    if (!findIndexExact(await movementCollection.listIndexes().toArray(), MOVEMENT_INDEX)) {
      await movementCollection.createIndex(MOVEMENT_INDEX.key, {
        name: MOVEMENT_INDEX.name,
        unique: false,
        partialFilterExpression: MOVEMENT_INDEX.partialFilterExpression,
      });
    }
    if (!findIndexExact(await movementCollection.listIndexes().toArray(), MOVEMENT_INDEX)) {
      throw new Error('Bank credit-movement provenance index could not be verified; legacy index was retained');
    }

    for (const index of legacy) {
      const current = (await collection.listIndexes().toArray()).find((candidate) => candidate.name === index.name);
      if (current && current.unique === true && sameKey(current.key, { bankTransactionId: 1 })) {
        await collection.dropIndex(current.name);
      }
    }

    const report = evaluateBankPaymentIndexes(await collection.listIndexes().toArray());
    const movementReport = evaluateBankCreditMovementIndexes(await movementCollection.listIndexes().toArray());
    if (!report.aligned || !movementReport.aligned) {
      throw new Error([...report.reasons, ...movementReport.reasons].join('; '));
    }
    console.log(JSON.stringify({ status: 'executed_verified', index: CHILD.name, movementIndex: MOVEMENT_INDEX.name }));
    return { status: 'executed_verified' };
  } finally {
    await mongoose.disconnect();
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  runBankPaymentChildIdentityMigration().catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
  });
}
