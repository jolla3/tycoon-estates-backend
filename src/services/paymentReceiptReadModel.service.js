// src/services/paymentReceiptReadModel.service.js
// G5 canonical Payments list: one row per confirmed/posted source receipt envelope.
// Payment children describe allocation destinations; CREDIT children are never receipts.
import mongoose from 'mongoose';
import { ManualReceipt } from '../models/ManualReceipt.js';
import { inspectMpesaIndexes } from '../utils/mpesaIndexReadiness.js';
import { inspectPaymentReceiptReadModelIndexes } from '../utils/paymentReceiptReadModelIndexReadiness.js';
import { Payment } from '../models/Payment.js';
import { PaymentAllocation } from '../models/PaymentAllocation.js';
import { TenantCreditMovement } from '../models/TenantCreditMovement.js';
import { Tenant } from '../models/Tenant.js';
import { House } from '../models/House.js';
import { Estate } from '../models/Estate.js';
import { Tenancy } from '../models/Tenancy.js';
import { RentCharge } from '../models/RentCharge.js';
import { dateUtil } from '../utils/date.js';
import { Errors } from '../utils/errors.js';
import { paginatedResponse } from '../utils/pagination.js';

const ID_RE = /^[a-f\d]{24}$/i;
const RECEIPT_SOURCES = Object.freeze(['MANUAL', 'MPESA', 'BANK']);
const CURRENT_TENANCY_STATES = ['ACTIVE', 'CLOSED'];
const sameId = (a, b) => a != null && b != null && String(a) === String(b);
const asString = (value) => value == null ? null : String(value);
const asObjectId = (value, field) => {
  if (value instanceof mongoose.Types.ObjectId) return value;
  const raw = String(value ?? '');
  if (!ID_RE.test(raw)) throw Errors.InvalidRequest(`${field} must be a valid ObjectId`);
  return new mongoose.Types.ObjectId(raw);
};
const safeCents = (value) => Number.isSafeInteger(value) && value >= 0;
const idList = (values) => [...new Map((values || []).filter(Boolean).map((value) => [String(value), value])).values()];
const sumSafe = (values) => {
  let total = 0;
  for (const value of values) {
    if (!Number.isSafeInteger(value)) return null;
    total += value;
    if (!Number.isSafeInteger(total)) return null;
  }
  return total;
};
const plusOne = (value) => Array.isArray(value) ? value : [];

function resolveEstateScope(estateFilter, requestedEstateId) {
  const requested = requestedEstateId ? asObjectId(requestedEstateId, 'estateId') : null;
  if (Array.isArray(estateFilter)) {
    const allowed = estateFilter.map((id) => asObjectId(id, 'estateFilter'));
    if (requested && !allowed.some((id) => sameId(id, requested))) {
      throw Errors.Forbidden('Requested estate is outside the authenticated estate scope');
    }
    return requested ? [requested] : allowed;
  }
  if (estateFilter != null) {
    const allowed = asObjectId(estateFilter, 'estateFilter');
    if (requested && !sameId(requested, allowed)) {
      throw Errors.Forbidden('Requested estate is outside the authenticated estate scope');
    }
    return [allowed];
  }
  return requested ? [requested] : null;
}

function resolveFilters(clientId, estateFilter, query = {}) {
  const client = asObjectId(clientId, 'clientId');
  const estates = resolveEstateScope(estateFilter, query.estateId);
  const tenantId = query.tenantId ? asObjectId(query.tenantId, 'tenantId') : null;
  const houseId = query.houseId ? asObjectId(query.houseId, 'houseId') : null;
  const page = query.page == null ? 1 : Number(query.page);
  const limit = query.limit == null ? 20 : Number(query.limit);
  if (!Number.isSafeInteger(page) || page < 1 || page > 10000) {
    throw Errors.InvalidRequest('page must be an integer from 1 to 10000');
  }
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100) {
    throw Errors.InvalidRequest('limit must be an integer from 1 to 100');
  }
  if (query.origin && !RECEIPT_SOURCES.includes(query.origin)) {
    throw Errors.InvalidRequest('origin must be MANUAL, MPESA, or BANK');
  }
  if (query.status && query.status !== 'CONFIRMED') {
    throw Errors.InvalidRequest('Only CONFIRMED receipt envelopes are available in Payments');
  }
  const methods = ['CASH', 'MPESA', 'BANK_TRANSFER', 'CHEQUE', 'OTHER'];
  if (query.tenderMethod && !methods.includes(query.tenderMethod)) {
    throw Errors.InvalidRequest('tenderMethod is invalid');
  }
  const start = query.startDate ? dateUtil.parseNairobiDateOnly(query.startDate) : null;
  const end = query.endDate ? dateUtil.parseNairobiDateOnly(query.endDate) : null;
  if (query.startDate && !start) throw Errors.InvalidRequest('startDate must be a real Nairobi calendar date (YYYY-MM-DD)');
  if (query.endDate && !end) throw Errors.InvalidRequest('endDate must be a real Nairobi calendar date (YYYY-MM-DD)');
  if (start && end && start.start > end.end) throw Errors.InvalidRequest('startDate must not be after endDate');
  return {
    client,
    estates,
    tenantId,
    houseId,
    page,
    limit,
    skip: (page - 1) * limit,
    origin: query.origin || null,
    tenderMethod: query.tenderMethod || null,
    dateRange: start || end ? {
      ...(start ? { $gte: start.start } : {}),
      ...(end ? { $lte: end.end } : {}),
    } : null,
  };
}

function estateMatch(estates, field = 'estateId') {
  return estates ? { [field]: { $in: estates } } : {};
}
function validReceiptCentsMatch(field) {
  return {
    $expr: {
      $and: [
        { $gt: [`$${field}`, 0] },
        { $lte: [`$${field}`, Number.MAX_SAFE_INTEGER] },
        { $eq: [{ $mod: [`$${field}`, 1] }, 0] },
      ],
    },
  };
}
function accountPair(row) {
  return { estateId: row.estateId, tenantId: row.tenantId };
}
function sourceLink(row) {
  if (row.origin === 'MANUAL') return { manualReceiptId: row.envelopeId };
  if (row.origin === 'MPESA') return { mpesaTransactionId: row.envelopeId };
  return { bankTransactionId: row.envelopeId };
}

function manualBranchMatch(f) {
  return {
    clientId: f.client,
    ...estateMatch(f.estates),
    status: 'CONFIRMED',
    ...(f.tenantId ? { tenantId: f.tenantId } : {}),
    ...(f.houseId ? { houseId: f.houseId } : {}),
    paymentDate: { $type: 'date', ...(f.dateRange || {}) },
    amountCents: { $type: 'number', $gt: 0 },
    ...(f.tenderMethod ? { tenderMethod: f.tenderMethod } : {}),
  };
}

function manualBranch(f) {
  return [
    { $match: manualBranchMatch(f) },
    { $match: validReceiptCentsMatch('amountCents') },
    {
      $lookup: {
        from: 'tenancies',
        localField: 'occupancyTenancyId',
        foreignField: '_id',
        as: 'sourceTenancy',
      },
    },
    { $unwind: '$sourceTenancy' },
    {
      $set: {
        _paymentDayStart: {
          $dateFromString: {
            dateString: '$paymentDateLocal',
            timezone: 'Africa/Nairobi',
            onError: null,
            onNull: null,
          },
        },
      },
    },
    {
      $set: {
        _paymentNextDayStart: {
          $cond: [
            { $ne: ['$_paymentDayStart', null] },
            {
              $dateAdd: {
                startDate: '$_paymentDayStart',
                unit: 'day',
                amount: 1,
                timezone: 'Africa/Nairobi',
              },
            },
            null,
          ],
        },
      },
    },
    {
      $set: {
        sourceTenancyValid: {
          $and: [
            { $eq: ['$sourceTenancy.clientId', '$clientId'] },
            { $eq: ['$sourceTenancy.estateId', '$estateId'] },
            { $eq: ['$sourceTenancy.tenantId', '$tenantId'] },
            { $eq: ['$sourceTenancy.houseId', '$houseId'] },
            { $in: ['$sourceTenancy.status', CURRENT_TENANCY_STATES] },
            { $ne: ['$_paymentDayStart', null] },
            { $ne: ['$_paymentNextDayStart', null] },
            { $lt: ['$sourceTenancy.startAt', '$_paymentNextDayStart'] },
            { $or: [
              { $eq: [{ $ifNull: ['$sourceTenancy.endAt', null] }, null] },
              { $gt: ['$sourceTenancy.endAt', '$_paymentDayStart'] },
            ] },
          ],
        },
      },
    },
    { $match: { sourceTenancyValid: true } },
    { $lookup: { from: 'houses', localField: 'sourceTenancy.houseId', foreignField: '_id', as: 'sourceHouse' } },
    { $unwind: '$sourceHouse' },
    { $match: { $expr: { $and: [ { $eq: ['$sourceHouse.clientId', '$clientId'] }, { $eq: ['$sourceHouse.estateId', '$estateId'] } ] } } },
    ...(f.houseId ? [{ $match: { 'sourceTenancy.houseId': f.houseId } }] : []),
    {
      $project: {
        _id: 0,
        envelopeId: '$_id',
        clientId: 1,
        estateId: 1,
        tenantId: 1,
        sourceHouseId: '$sourceTenancy.houseId',
        sourceHouseNumber: '$sourceHouse.houseNumber',
        sourceTenancyId: '$occupancyTenancyId',
        sourceTenancyValid: 1,
        origin: { $literal: 'MANUAL' },
        listKind: { $literal: 'manual_receipt' },
        amountCents: '$amountCents',
        grossReceivedCents: '$amountCents',
        paymentDate: '$paymentDate',
        paymentDateLocal: 1,
        receivedAt: '$paymentDate',
        paymentReference: { $ifNull: ['$paymentReference', null] },
        period: 1,
        tenderMethod: 1,
        status: 1,
        paymentIds: { $ifNull: ['$paymentIds', []] },
        creditPaymentIds: { $ifNull: ['$creditPaymentIds', []] },
        creditMovementIds: { $ifNull: ['$creditMovementIds', []] },
        receiptAppliedCents: { $ifNull: ['$receiptAppliedCents', null] },
        creditAppliedCents: { $ifNull: ['$creditAppliedCents', null] },
        newCreditCents: { $ifNull: ['$newCreditCents', null] },
        creditBeforeCents: { $ifNull: ['$creditBeforeCents', null] },
        creditRemainingCents: { $ifNull: ['$creditRemainingCents', null] },
        creditAfterCents: { $ifNull: ['$creditAfterCents', null] },
        settlementVersion: { $ifNull: ['$settlementVersion', null] },
        provider: { $literal: null },
        providerTransactionId: { $literal: null },
        businessShortCode: { $literal: null },
        sourceAmountConsistent: { $literal: true },
        legacy: { $literal: false },
      },
    },
  ];
}

function mpesaBranch(f) {
  const match = {
    clientId: f.client,
    attributedClientId: f.client,
    ...estateMatch(f.estates, 'attributedEstateId'),
    postingState: 'POSTED',
    verificationState: 'MATCHED',
    allocationState: { $in: ['ALLOCATED_BY_REFERENCE', 'ALLOCATED_BY_EVIDENCE'] },
    transactionAt: { $type: 'date', ...(f.dateRange || {}) },
    attributedTenantId: { $type: 'objectId' },
    attributedTenancyId: { $type: 'objectId' },
    acceptedAmountCents: { $type: 'number', $gt: 0 },
    ...(f.tenantId ? { attributedTenantId: f.tenantId } : {}),
  };
  return [
    { $match: match },
    { $match: validReceiptCentsMatch('acceptedAmountCents') },
    {
      $lookup: {
        from: 'tenancies',
        localField: 'attributedTenancyId',
        foreignField: '_id',
        as: 'sourceTenancy',
      },
    },
    { $unwind: { path: '$sourceTenancy', preserveNullAndEmptyArrays: true } },
    {
      $set: {
        sourceTenancyValid: {
          $and: [
            { $eq: ['$sourceTenancy.clientId', '$attributedClientId'] },
            { $eq: ['$sourceTenancy.estateId', '$attributedEstateId'] },
            { $eq: ['$sourceTenancy.tenantId', '$attributedTenantId'] },
            { $in: ['$sourceTenancy.status', CURRENT_TENANCY_STATES] },
            { $lte: ['$sourceTenancy.startAt', '$transactionAt'] },
            { $or: [
              { $eq: [{ $ifNull: ['$sourceTenancy.endAt', null] }, null] },
              { $gt: ['$sourceTenancy.endAt', '$transactionAt'] },
            ] },
            { $eq: ['$transactionAt', '$acceptedTransactionAt'] },
          ],
        },
      },
    },
    { $match: { sourceTenancyValid: true } },
    { $lookup: { from: 'houses', localField: 'sourceTenancy.houseId', foreignField: '_id', as: 'sourceHouse' } },
    { $unwind: '$sourceHouse' },
    { $match: { $expr: { $and: [ { $eq: ['$sourceHouse.clientId', '$attributedClientId'] }, { $eq: ['$sourceHouse.estateId', '$attributedEstateId'] } ] } } },
    ...(f.houseId ? [{ $match: { 'sourceTenancy.houseId': f.houseId } }] : []),
    ...(f.tenderMethod && f.tenderMethod !== 'MPESA' ? [{ $match: { _id: { $exists: false } } }] : []),
    {
      $project: {
        _id: 0,
        envelopeId: '$_id',
        clientId: '$attributedClientId',
        estateId: '$attributedEstateId',
        tenantId: '$attributedTenantId',
        sourceHouseId: '$sourceTenancy.houseId',
        sourceHouseNumber: '$sourceHouse.houseNumber',
        sourceTenancyId: '$attributedTenancyId',
        sourceTenancyValid: 1,
        origin: { $literal: 'MPESA' },
        listKind: { $literal: 'payment' },
        amountCents: '$acceptedAmountCents',
        grossReceivedCents: '$acceptedAmountCents',
        paymentDate: '$transactionAt',
        receivedAt: '$transactionAt',
        paymentReference: { $ifNull: ['$receiptNumber', null] },
        period: { $literal: null },
        tenderMethod: { $literal: 'MPESA' },
        status: { $literal: 'CONFIRMED' },
        paymentIds: {
          $cond: [
            { $gt: [{ $size: { $ifNull: ['$paymentIds', []] } }, 0] },
            '$paymentIds',
            { $cond: [{ $ne: ['$paymentId', null] }, ['$paymentId'], []] },
          ],
        },
        creditPaymentIds: { $ifNull: ['$creditPaymentIds', []] },
        creditMovementIds: { $ifNull: ['$creditMovementIds', []] },
        receiptAppliedCents: { $ifNull: ['$receiptAppliedCents', null] },
        creditAppliedCents: { $ifNull: ['$creditAppliedCents', null] },
        newCreditCents: { $ifNull: ['$newCreditCents', '$creditEarnedCents'] },
        creditEarnedCents: { $ifNull: ['$creditEarnedCents', null] },
        creditBeforeCents: { $ifNull: ['$creditBeforeCents', null] },
        creditRemainingCents: { $ifNull: ['$creditRemainingCents', null] },
        creditAfterCents: { $ifNull: ['$creditAfterCents', null] },
        settlementVersion: { $ifNull: ['$settlementVersion', null] },
        provider: 1,
        providerTransactionId: 1,
        businessShortCode: 1,
        sourceAmountConsistent: { $eq: ['$amountCents', '$acceptedAmountCents'] },
        legacy: { $literal: false },
      },
    },
  ];
}

function bankBranch(f) {
  const match = {
    clientId: f.client,
    ...estateMatch(f.estates),
    processingState: 'POSTED',
    eventType: 'CREDIT',
    matchStatus: 'MATCHED',
    matchedHouseId: { $type: 'objectId' },
    matchedTenantId: { $type: 'objectId' },
    matchedTenancyId: { $type: 'objectId' },
    ...(f.tenantId ? { matchedTenantId: f.tenantId } : {}),
    ...(f.houseId ? { matchedHouseId: f.houseId } : {}),
    transactionDate: { $type: 'date', ...(f.dateRange || {}) },
    amountCents: { $type: 'number', $gt: 0 },
  };
  return [
    { $match: match },
    { $match: validReceiptCentsMatch('amountCents') },
    {
      $lookup: {
        from: 'tenancies',
        localField: 'matchedTenancyId',
        foreignField: '_id',
        as: 'sourceTenancy',
      },
    },
    { $unwind: { path: '$sourceTenancy', preserveNullAndEmptyArrays: true } },
    {
      $set: {
        sourceTenancyValid: {
          $and: [
            { $eq: ['$sourceTenancy.clientId', '$clientId'] },
            { $eq: ['$sourceTenancy.estateId', '$estateId'] },
            { $eq: ['$sourceTenancy.tenantId', '$matchedTenantId'] },
            { $eq: ['$sourceTenancy.houseId', '$matchedHouseId'] },
            { $in: ['$sourceTenancy.status', CURRENT_TENANCY_STATES] },
            { $lte: ['$sourceTenancy.startAt', '$transactionDate'] },
            { $or: [
              { $eq: [{ $ifNull: ['$sourceTenancy.endAt', null] }, null] },
              { $gt: ['$sourceTenancy.endAt', '$transactionDate'] },
            ] },
          ],
        },
      },
    },
    { $match: { sourceTenancyValid: true } },
    { $lookup: { from: 'houses', localField: 'sourceTenancy.houseId', foreignField: '_id', as: 'sourceHouse' } },
    { $unwind: '$sourceHouse' },
    { $match: { $expr: { $and: [ { $eq: ['$sourceHouse.clientId', '$clientId'] }, { $eq: ['$sourceHouse.estateId', '$estateId'] } ] } } },
    ...(f.tenderMethod && f.tenderMethod !== 'BANK_TRANSFER' ? [{ $match: { _id: { $exists: false } } }] : []),
    {
      $project: {
        _id: 0,
        envelopeId: '$_id',
        clientId: 1,
        estateId: 1,
        tenantId: '$matchedTenantId',
        sourceHouseId: '$matchedHouseId',
        sourceHouseNumber: '$sourceHouse.houseNumber',
        sourceTenancyId: '$matchedTenancyId',
        sourceTenancyValid: 1,
        origin: { $literal: 'BANK' },
        listKind: { $literal: 'payment' },
        amountCents: '$amountCents',
        grossReceivedCents: '$amountCents',
        paymentDate: '$transactionDate',
        receivedAt: '$transactionDate',
        paymentReference: { $ifNull: ['$paymentReference', null] },
        period: { $literal: null },
        tenderMethod: { $literal: 'BANK_TRANSFER' },
        status: { $literal: 'CONFIRMED' },
        paymentIds: { $ifNull: ['$paymentIds', []] },
        creditPaymentIds: { $ifNull: ['$creditPaymentIds', []] },
        creditMovementIds: { $ifNull: ['$creditMovementIds', []] },
        receiptAppliedCents: { $ifNull: ['$receiptAppliedCents', null] },
        creditAppliedCents: { $ifNull: ['$creditAppliedCents', null] },
        newCreditCents: { $ifNull: ['$newCreditCents', null] },
        creditBeforeCents: { $ifNull: ['$creditBeforeCents', null] },
        creditRemainingCents: { $ifNull: ['$creditRemainingCents', null] },
        creditAfterCents: { $ifNull: ['$creditAfterCents', null] },
        settlementVersion: { $ifNull: ['$settlementVersion', null] },
        provider: 1,
        providerTransactionId: 1,
        businessShortCode: { $literal: null },
        sourceAmountConsistent: { $literal: true },
        legacy: { $cond: [{ $eq: ['$settlementVersion', 1] }, false, true] },
      },
    },
  ];
}

function legacyManualBranch(f) {
  const match = {
    clientId: f.client,
    ...estateMatch(f.estates),
    origin: 'MANUAL',
    status: 'CONFIRMED',
    $or: [{ manualReceiptId: null }, { manualReceiptId: { $exists: false } }],
    ...(f.tenantId ? { tenantId: f.tenantId } : {}),
    ...(f.houseId ? { houseId: f.houseId } : {}),
    paymentDate: { $type: 'date', ...(f.dateRange || {}) },
    amountCents: { $type: 'number', $gt: 0 },
    ...(f.tenderMethod ? { tenderMethod: f.tenderMethod } : {}),
  };
  return [
    { $match: match },
    { $match: validReceiptCentsMatch('amountCents') },
    {
      $project: {
        _id: 0,
        envelopeId: '$_id',
        legacyPaymentId: '$_id',
        clientId: 1,
        estateId: 1,
        tenantId: 1,
        sourceHouseId: '$houseId',
        sourceTenancyId: '$tenancyId',
        origin: 1,
        listKind: { $literal: 'payment' },
        amountCents: 1,
        grossReceivedCents: 1,
        paymentDate: 1,
        receivedAt: '$paymentDate',
        paymentReference: { $ifNull: ['$paymentReference', null] },
        period: 1,
        tenderMethod: 1,
        status: 1,
        paymentIds: [],
        creditPaymentIds: [],
        creditMovementIds: [],
        receiptAppliedCents: { $literal: null },
        creditAppliedCents: { $literal: null },
        newCreditCents: { $literal: null },
        creditBeforeCents: { $literal: null },
        creditRemainingCents: { $literal: null },
        creditAfterCents: { $literal: null },
        settlementVersion: { $literal: null },
        provider: { $literal: null },
        providerTransactionId: { $literal: null },
        businessShortCode: { $literal: null },
        sourceAmountConsistent: { $literal: false },
        legacy: { $literal: true },
      },
    },
  ];
}

async function aggregatePage(f) {
  const stages = manualBranch(f);
  // No origin filter means all source envelopes, including MANUAL receipts.
  // Suppress this branch only when the caller explicitly requested another source.
  if (f.origin && f.origin !== 'MANUAL') {
    stages[0] = { $match: { _id: { $exists: false } } };
  }
  if (!f.origin || f.origin === 'MPESA') {
    stages.push({ $unionWith: { coll: 'mpesatransactions', pipeline: mpesaBranch(f) } });
  }
  if (!f.origin || f.origin === 'BANK') {
    stages.push({ $unionWith: { coll: 'banktransactions', pipeline: bankBranch(f) } });
  }
  if (!f.origin || f.origin === 'MANUAL') {
    stages.push({ $unionWith: { coll: 'payments', pipeline: legacyManualBranch(f) } });
  }
  stages.push(
    { $sort: { receivedAt: -1, envelopeId: -1, origin: 1 } },
    {
      $facet: {
        items: [{ $skip: f.skip }, { $limit: f.limit }],
        total: [{ $count: 'count' }],
      },
    }
  );
  const [result] = await ManualReceipt.aggregate(stages).allowDiskUse(true);
  return result || { items: [], total: [] };
}

function movementQuery(rows) {
  const clauses = rows.map((row) => ({
    ...accountPair(row),
    clientId: row.clientId,
    ...sourceLink(row),
  }));
  return clauses.length ? { $or: clauses } : null;
}
function paymentQuery(rows, movements) {
  const clauses = [];
  for (const row of rows) {
    const common = { clientId: row.clientId, estateId: row.estateId, tenantId: row.tenantId, status: 'CONFIRMED' };
    if (row.legacyPaymentId) {
      clauses.push({ ...common, origin: 'MANUAL', _id: row.legacyPaymentId });
      continue;
    }
    const sourceIds = idList(plusOne(row.paymentIds));
    if (row.origin === 'MANUAL') {
      clauses.push({ ...common, origin: 'MANUAL', manualReceiptId: row.envelopeId });
      if (sourceIds.length) clauses.push({ ...common, origin: 'MANUAL', manualReceiptId: row.envelopeId, _id: { $in: sourceIds } });
    } else if (row.origin === 'MPESA') {
      clauses.push({ ...common, origin: 'MPESA', mpesaReceiptId: row.envelopeId });
      if (sourceIds.length) clauses.push({ ...common, origin: 'MPESA', mpesaReceiptId: row.envelopeId, _id: { $in: sourceIds } });
    } else if (row.origin === 'BANK') {
      clauses.push({ ...common, origin: 'BANK', bankTransactionId: row.envelopeId });
      if (sourceIds.length) clauses.push({ ...common, origin: 'BANK', bankTransactionId: row.envelopeId, _id: { $in: sourceIds } });
    }
    const movementCreditIds = movements
      .filter((movement) => movement.movementType === 'CREDIT_APPLIED'
        && sameId(movement.clientId, row.clientId)
        && sameId(movement.estateId, row.estateId)
        && sameId(movement.tenantId, row.tenantId)
        && sameId(movement[sourceLink(row) ? Object.keys(sourceLink(row))[0] : ''], row.envelopeId)
        && movement.paymentId)
      .map((movement) => movement.paymentId);
    const creditIds = idList([...plusOne(row.creditPaymentIds), ...movementCreditIds]);
    if (creditIds.length) {
      clauses.push({ ...common, origin: 'CREDIT', _id: { $in: creditIds } });
    }
  }
  return clauses.length ? { $or: clauses } : null;
}

function movementForRow(movements, row) {
  return movements.filter((movement) =>
    sameId(movement.clientId, row.clientId)
    && sameId(movement.estateId, row.estateId)
    && sameId(movement.tenantId, row.tenantId)
    && sameId(movement[sourceLink(row) ? Object.keys(sourceLink(row))[0] : ''], row.envelopeId)
  );
}
function paymentForRow(payments, row) {
  const persistedCreditIds = new Set(plusOne(row.creditPaymentIds).map(String));
  const movementCreditIds = new Set((row._movements || [])
    .filter((movement) => movement.movementType === 'CREDIT_APPLIED' && movement.paymentId)
    .map((movement) => String(movement.paymentId)));
  return payments.filter((payment) => {
    if (!sameId(payment.clientId, row.clientId)
      || !sameId(payment.estateId, row.estateId)
      || !sameId(payment.tenantId, row.tenantId)) return false;
    if (row.legacyPaymentId) return sameId(payment._id, row.legacyPaymentId);
    if (payment.origin === row.origin) {
      const linked = row.origin === 'MANUAL' ? sameId(payment.manualReceiptId, row.envelopeId)
        : row.origin === 'MPESA' ? sameId(payment.mpesaReceiptId, row.envelopeId)
          : row.origin === 'BANK' ? sameId(payment.bankTransactionId, row.envelopeId) : false;
      return linked;
    }
    return payment.origin === 'CREDIT'
      && (persistedCreditIds.has(String(payment._id)) || movementCreditIds.has(String(payment._id)));
  });
}

function verifySourceTenancy(row, tenancy) {
  if (!tenancy
    || !sameId(tenancy.clientId, row.clientId)
    || !sameId(tenancy.estateId, row.estateId)
    || !sameId(tenancy.tenantId, row.tenantId)
    || !CURRENT_TENANCY_STATES.includes(tenancy.status)) return false;
  if (row.sourceHouseId && !sameId(tenancy.houseId, row.sourceHouseId)) return false;
  const startAt = new Date(tenancy.startAt).getTime();
  const endAt = tenancy.endAt == null ? null : new Date(tenancy.endAt).getTime();
  if (!Number.isFinite(startAt)) return false;

  // ManualReceipt.paymentDate is a noon-Nairobi representative timestamp.
  // Its immutable paymentDateLocal is the authoritative calendar-day identity.
  if (row.origin === 'MANUAL' && typeof row.paymentDateLocal === 'string') {
    const paymentDay = dateUtil.parseNairobiDateOnly(row.paymentDateLocal);
    if (!paymentDay) return false;
    const dayStart = paymentDay.start.getTime();
    const dayEnd = paymentDay.end.getTime();
    return Number.isFinite(dayStart)
      && Number.isFinite(dayEnd)
      && startAt <= dayEnd
      && (endAt == null || (Number.isFinite(endAt) && endAt > dayStart));
  }

  const eventAt = new Date(row.paymentDate || row.receivedAt).getTime();
  return Number.isFinite(eventAt)
    && eventAt >= startAt
    && (endAt == null || (Number.isFinite(endAt) && eventAt < endAt));
}

async function currentAccountPositions(rows, clientId) {
  const accounts = [...new Map(rows.map((row) => [`${row.estateId}:${row.tenantId}`, accountPair(row)])).values()];
  if (!accounts.length) return new Map();
  const accountFilter = { $or: accounts };
  const [creditRows, tenancies] = await Promise.all([
    TenantCreditMovement.aggregate([
      { $match: { clientId, ...accountFilter } },
      { $group: { _id: { estateId: '$estateId', tenantId: '$tenantId' }, creditCents: { $sum: '$amountCents' } } },
    ]),
    Tenancy.find({ clientId, ...accountFilter, status: { $in: CURRENT_TENANCY_STATES } })
      .select('_id estateId tenantId').lean(),
  ]);
  const tenancyIds = tenancies.map((tenancy) => tenancy._id);
  const outstandingRows = tenancyIds.length
    ? await RentCharge.aggregate([
      {
        $match: {
          $or: tenancies.map((tenancy) => ({
            clientId,
            estateId: tenancy.estateId,
            tenantId: tenancy.tenantId,
            tenancyId: tenancy._id,
          })),
          status: { $in: ['UNPAID', 'PARTIAL'] },
          balanceCents: { $gt: 0 },
        },
      },
      { $group: { _id: '$tenancyId', outstandingCents: { $sum: '$balanceCents' } } },
    ])
    : [];
  const creditByAccount = new Map(creditRows.map((row) => [`${row._id.estateId}:${row._id.tenantId}`, row.creditCents || 0]));
  const tenancyAccount = new Map(tenancies.map((tenancy) => [String(tenancy._id), `${tenancy.estateId}:${tenancy.tenantId}`]));
  const outstandingByAccount = new Map();
  for (const row of outstandingRows) {
    const key = tenancyAccount.get(String(row._id));
    if (!key) continue;
    outstandingByAccount.set(key, (outstandingByAccount.get(key) || 0) + (row.outstandingCents || 0));
  }
  const asOf = new Date().toISOString();
  const positions = new Map();
  for (const row of rows) {
    const key = `${row.estateId}:${row.tenantId}`;
    const creditCents = creditByAccount.get(key) || 0;
    const outstandingCents = outstandingByAccount.get(key) || 0;
    const valid = safeCents(creditCents) && safeCents(outstandingCents);
    positions.set(key, valid ? {
      creditCents,
      outstandingCents,
      netCents: creditCents - outstandingCents,
      asOf,
      balanceScope: 'CURRENT',
    } : null);
  }
  return positions;
}

function reconcileRow(row, rowPayments, rowMovements, allocations, allocationsChargeMap) {
  const receiptPayments = rowPayments.filter((payment) => payment.origin === row.origin);
  const creditPayments = rowPayments.filter((payment) => payment.origin === 'CREDIT');
  const receiptAllocations = allocations.filter((allocation) => {
    const payment = rowPayments.find((candidate) => sameId(candidate._id, allocation.paymentId));
    return payment?.origin === row.origin;
  });
  const creditAllocations = allocations.filter((allocation) => {
    const payment = rowPayments.find((candidate) => sameId(candidate._id, allocation.paymentId));
    return payment?.origin === 'CREDIT';
  });
  const receiptAllocationCents = sumSafe(receiptAllocations.map((item) => item.amountCents));
  const receiptPaymentCents = sumSafe(receiptPayments.map((item) => item.amountCents));
  const creditMovementCents = sumSafe(rowMovements
    .filter((movement) => movement.movementType === 'CREDIT_APPLIED')
    .map((movement) => Math.abs(movement.amountCents)));
  const surplusMovementCents = sumSafe(rowMovements
    .filter((movement) => movement.movementType === 'RECEIPT_SURPLUS')
    .map((movement) => movement.amountCents));
  const creditPaymentCents = sumSafe(creditPayments.map((item) => item.amountCents));
  const creditAllocationCents = sumSafe(creditAllocations.map((item) => item.amountCents));
  const sameIdArray = (left, right) => {
    const a = (Array.isArray(left) ? left : []).map(String).sort();
    const b = (Array.isArray(right) ? right : []).map(String).sort();
    return a.length === b.length && a.every((id, index) => id === b[index]);
  };
  const sourceChildIdentityVerified = row.settlementVersion !== 1 || (
    sameIdArray(row.paymentIds, receiptPayments.map((payment) => payment._id))
    && sameIdArray(row.creditPaymentIds, creditPayments.map((payment) => payment._id))
    && sameIdArray(row.creditMovementIds, rowMovements.map((movement) => movement._id))
  );
  const allocationDestinationsVerified = allocations.every((allocation) => {
    const payment = rowPayments.find((candidate) => sameId(candidate._id, allocation.paymentId));
    const charge = allocationsChargeMap.get(String(allocation.rentChargeId));
    return Boolean(payment && charge && sameId(charge.clientId, row.clientId)
      && sameId(charge.estateId, row.estateId) && sameId(charge.tenantId, payment.tenantId)
      && sameId(charge.tenancyId, payment.tenancyId) && sameId(charge.tenancyId, allocation.tenancyId)
      && sameId(charge.houseId, payment.houseId) && sameId(charge.period, allocation.period)
      && sameId(charge.chargeType, allocation.chargeType));
  });

  const receiptAppliedCents = safeCents(row.receiptAppliedCents)
    ? row.receiptAppliedCents
    : receiptAllocationCents;
  let creditAppliedCents = safeCents(row.creditAppliedCents) ? row.creditAppliedCents : null;
  if (creditAppliedCents == null && creditMovementCents != null
    && (!row.legacy || row.origin === 'MPESA' || row.origin === 'MANUAL')) {
    creditAppliedCents = creditMovementCents;
  }
  let newCreditCents = safeCents(row.newCreditCents) ? row.newCreditCents : null;
  if (newCreditCents == null && row.origin === 'MPESA' && safeCents(row.creditEarnedCents)) {
    newCreditCents = row.creditEarnedCents;
  }
  if (newCreditCents == null && surplusMovementCents != null && surplusMovementCents > 0) {
    newCreditCents = surplusMovementCents;
  }
  if (newCreditCents == null && receiptAppliedCents != null
    && safeCents(row.grossReceivedCents) && receiptAppliedCents === row.grossReceivedCents) {
    newCreditCents = 0;
  }

  const gross = row.grossReceivedCents;
  const receiptReconciled = Number.isSafeInteger(gross) && gross > 0
    && safeCents(receiptAppliedCents)
    && safeCents(newCreditCents)
    && receiptPaymentCents != null
    && receiptAllocationCents != null
    && receiptAppliedCents + newCreditCents === gross
    && receiptPaymentCents === receiptAppliedCents
    && receiptAllocationCents === receiptAppliedCents
    && sourceChildIdentityVerified
    && allocationDestinationsVerified;
  const creditSnapshotPresent = safeCents(row.creditBeforeCents)
    && safeCents(row.creditRemainingCents)
    && safeCents(row.creditAfterCents);
  const creditReconciled = creditSnapshotPresent
    && safeCents(creditAppliedCents)
    && safeCents(newCreditCents)
    && creditAppliedCents + row.creditRemainingCents === row.creditBeforeCents
    && row.creditAfterCents === row.creditRemainingCents + newCreditCents
    && creditPaymentCents != null
    && creditMovementCents != null
    && creditAllocationCents != null
    && creditPaymentCents === creditAppliedCents
    && creditMovementCents === creditAppliedCents
    && creditAllocationCents === creditAppliedCents
    && sourceChildIdentityVerified
    && allocationDestinationsVerified;

  return {
    receiptPayments,
    creditPayments,
    receiptAllocations,
    creditAllocations,
    sourceChildIdentityVerified,
    allocationDestinationsVerified,
    receiptAppliedCents: safeCents(receiptAppliedCents) ? receiptAppliedCents : null,
    creditAppliedCents: safeCents(creditAppliedCents) ? creditAppliedCents : null,
    newCreditCents: safeCents(newCreditCents) ? newCreditCents : null,
    receiptReconciliation: receiptReconciled ? 'VERIFIED' : 'UNVERIFIED_OR_INCONSISTENT',
    creditReconciliation: creditReconciled ? 'VERIFIED' : 'SNAPSHOT_UNAVAILABLE_OR_INCONSISTENT',
    creditBeforeCents: safeCents(row.creditBeforeCents) ? row.creditBeforeCents : null,
    creditRemainingCents: safeCents(row.creditRemainingCents) ? row.creditRemainingCents : null,
    creditAfterCents: safeCents(row.creditAfterCents) ? row.creditAfterCents : null,
  };
}

async function hydratePage(items, f) {
  if (!items.length) return [];
  const rows = items.map((row) => ({ ...row, clientId: f.client }));
  const sourceTenancyIds = idList(rows.map((row) => row.sourceTenancyId));
  const movementOr = movementQuery(rows);
  const [tenants, sourceTenancies, movements] = await Promise.all([
    Tenant.find({ _id: { $in: idList(rows.map((row) => row.tenantId)) }, clientId: f.client })
      .select('_id name phone').lean(),
    sourceTenancyIds.length
      ? Tenancy.find({ _id: { $in: sourceTenancyIds }, clientId: f.client })
        .select('_id clientId estateId tenantId houseId status startAt endAt').lean()
      : [],
    movementOr ? TenantCreditMovement.find(movementOr).lean() : [],
  ]);
  const sourceTenancyMap = new Map(sourceTenancies.map((tenancy) => [String(tenancy._id), tenancy]));
  const rowMovements = new Map();
  for (const row of rows) {
    const matches = movementForRow(movements, row);
    row._movements = matches;
    rowMovements.set(String(row.envelopeId), matches);
    const tenancy = sourceTenancyMap.get(String(row.sourceTenancyId));
    const sourceValid = verifySourceTenancy(row, tenancy);
    row.sourceTenancyStatus = sourceValid ? 'VERIFIED' : (row.legacy ? 'LEGACY_UNVERIFIED' : 'UNVERIFIED');
    if (row.origin === 'MPESA') {
      row.sourceHouseId = sourceValid ? tenancy.houseId : null;
    }
  }
  const query = paymentQuery(rows, movements);
  const payments = query ? await Payment.find(query).lean() : [];
  const paymentIds = idList(payments.map((payment) => payment._id));
  const allocations = paymentIds.length
    ? await PaymentAllocation.find({
      clientId: f.client,
      estateId: { $in: idList(rows.map((row) => row.estateId)) },
      paymentId: { $in: paymentIds },
    }).lean()
    : [];
  const chargeIds = idList(allocations.map((allocation) => allocation.rentChargeId));
  const charges = chargeIds.length
    ? await RentCharge.find({
      _id: { $in: chargeIds },
      clientId: f.client,
      estateId: { $in: idList(rows.map((row) => row.estateId)) },
    }).select('_id clientId estateId houseId tenantId tenancyId period chargeType').lean()
    : [];
  const chargeMap = new Map(charges.map((charge) => [String(charge._id), charge]));
  const houseIds = idList([
    ...rows.map((row) => row.sourceHouseId),
    ...payments.map((payment) => payment.houseId),
  ]);
  const estateIds = idList(rows.map((row) => row.estateId));
  const [houses, estates, positions] = await Promise.all([
    houseIds.length ? House.find({ _id: { $in: houseIds }, clientId: f.client, estateId: { $in: idList(rows.map((row) => row.estateId)) } }).select('_id estateId houseNumber').lean() : [],
    estateIds.length ? Estate.find({ _id: { $in: estateIds }, clientId: f.client }).select('_id name').lean() : [],
    currentAccountPositions(rows, f.client),
  ]);
  const tenantMap = new Map(tenants.map((tenant) => [String(tenant._id), tenant]));
  const houseMap = new Map(houses.map((house) => [String(house._id), house]));
  const estateMap = new Map(estates.map((estate) => [String(estate._id), estate]));
  const paymentsByRow = new Map();
  for (const row of rows) paymentsByRow.set(String(row.envelopeId), paymentForRow(payments, row));
  const allocationsByRow = new Map();
  for (const row of rows) {
    const rowPaymentIds = new Set((paymentsByRow.get(String(row.envelopeId)) || []).map((payment) => String(payment._id)));
    allocationsByRow.set(String(row.envelopeId), allocations.filter((allocation) => rowPaymentIds.has(String(allocation.paymentId))));
  }

  return rows.map((row) => {
    const rowPayments = paymentsByRow.get(String(row.envelopeId)) || [];
    const rowAllocationRows = allocationsByRow.get(String(row.envelopeId)) || [];
    const rowMovementRows = rowMovements.get(String(row.envelopeId)) || [];
    const accounting = reconcileRow(row, rowPayments, rowMovementRows, rowAllocationRows, chargeMap);
    const allocationBreakdown = rowAllocationRows.map((allocation) => {
      const payment = rowPayments.find((candidate) => sameId(candidate._id, allocation.paymentId));
      const charge = chargeMap.get(String(allocation.rentChargeId));
      const house = payment ? houseMap.get(String(payment.houseId)) : null;
      const destinationVerified = Boolean(payment && charge
        && sameId(charge.clientId, row.clientId)
        && sameId(charge.estateId, row.estateId)
        && sameId(charge.tenantId, payment.tenantId)
        && sameId(charge.tenancyId, payment.tenancyId)
        && sameId(charge.tenancyId, allocation.tenancyId)
        && sameId(charge.houseId, payment.houseId)
        && sameId(charge.period, allocation.period)
        && sameId(charge.chargeType, allocation.chargeType));
      return {
        paymentId: asString(allocation.paymentId),
        fundingSource: payment?.origin === 'CREDIT' ? 'EXISTING_CREDIT' : 'RECEIPT',
        paymentOrigin: payment?.origin || null,
        tenancyId: asString(allocation.tenancyId),
        houseId: asString(payment?.houseId),
        houseNumber: house?.houseNumber ?? null,
        rentChargeId: asString(allocation.rentChargeId),
        amountCents: allocation.amountCents,
        chargeType: allocation.chargeType,
        period: allocation.period,
        destinationVerified,
      };
    });
    const tenant = tenantMap.get(String(row.tenantId));
    const house = row.sourceHouseId ? houseMap.get(String(row.sourceHouseId)) : null;
    const estate = estateMap.get(String(row.estateId));
    const accountPosition = positions.get(`${row.estateId}:${row.tenantId}`) || null;
    const receivedAt = row.receivedAt instanceof Date ? row.receivedAt.toISOString() : new Date(row.receivedAt).toISOString();
    return {
      _id: asString(row.envelopeId),
      manualReceiptId: row.origin === 'MANUAL' && !row.legacy ? asString(row.envelopeId) : null,
      bankTransactionId: row.origin === 'BANK' ? asString(row.envelopeId) : null,
      clientId: asString(row.clientId),
      estateId: asString(row.estateId),
      estateName: estate?.name ?? null,
      houseId: asString(row.sourceHouseId),
      houseNumber: house?.houseNumber ?? null,
      tenantId: asString(row.tenantId),
      tenantName: tenant?.name ?? null,
      tenancyId: asString(row.sourceTenancyId),
      origin: row.origin,
      source: row.origin,
      listKind: row.listKind,
      amountCents: row.grossReceivedCents,
      grossReceivedCents: row.grossReceivedCents,
      paymentDate: receivedAt,
      receivedAt,
      paymentReference: row.paymentReference ?? null,
      period: row.period || dateUtil.periodOf(receivedAt),
      status: row.status || 'CONFIRMED',
      tenderMethod: row.tenderMethod ?? null,
      provider: row.provider ?? null,
      providerTransactionId: row.providerTransactionId ?? null,
      businessShortCode: row.businessShortCode ?? null,
      isMoneyReceived: true,
      sourceTenancyStatus: row.sourceTenancyStatus || (row.legacy ? 'LEGACY_UNVERIFIED' : 'VERIFIED'),
      sourceAmountConsistent: row.sourceAmountConsistent !== false && Number.isSafeInteger(row.grossReceivedCents) && row.grossReceivedCents > 0,
      legacy: Boolean(row.legacy),
      paymentIds: accounting.receiptPayments.map((payment) => asString(payment._id)),
      creditPaymentIds: accounting.creditPayments.map((payment) => asString(payment._id)),
      creditMovementIds: rowMovementRows.map((movement) => asString(movement._id)),
      receiptAppliedCents: accounting.receiptAppliedCents,
      creditAppliedCents: accounting.creditAppliedCents,
      newCreditCents: accounting.newCreditCents,
      creditBeforeCents: accounting.creditBeforeCents,
      creditRemainingCents: accounting.creditRemainingCents,
      creditAfterCents: accounting.creditAfterCents,
      receiptReconciliation: row.legacy ? 'LEGACY_UNVERIFIED' : accounting.receiptReconciliation,
      creditReconciliation: row.legacy ? 'LEGACY_UNVERIFIED' : accounting.creditReconciliation,
      settlementIdentity: row.legacy ? 'LEGACY_UNVERIFIED' : (accounting.sourceChildIdentityVerified && accounting.allocationDestinationsVerified ? 'VERIFIED' : 'MISMATCH'),
      allocationBreakdown,
      currentAccountPosition: accountPosition,
    };
  });
}

export const paymentReceiptReadModelService = {
  async list(clientId, estateFilter, query = {}) {
    const f = resolveFilters(clientId, estateFilter, query);
    const indexes = await inspectPaymentReceiptReadModelIndexes();
    if (!indexes.aligned) throw Errors.ServiceUnavailable('Payment receipt read-model indexes are not ready');
    if (!f.origin || f.origin === 'MPESA') {
      const mpesaIndexes = await inspectMpesaIndexes();
      if (mpesaIndexes?.gates?.canonicalQueryIndexes !== true) {
        throw Errors.ServiceUnavailable('M-PESA receipt query indexes are not ready');
      }
    }
    const facet = await aggregatePage(f);
    const items = await hydratePage(facet.items || [], f);
    const total = facet.total?.[0]?.count || 0;
    return paginatedResponse(items, total, { page: f.page, limit: f.limit });
  },
};
