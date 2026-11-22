import { MpesaTransaction } from '../models/MpesaTransaction.js';
import { paginationParams, paginatedResponse } from '../utils/pagination.js';
import { inspectMpesaIndexes } from '../utils/mpesaIndexReadiness.js';
import { Errors } from '../utils/errors.js';
import { toMpesaTransactionDTO } from '../utils/mpesaTransactionDto.js';
import { summarizeReceipts, SUMMARY_MAX_WINDOW_DAYS } from './mpesaReceiptSummary.js';

/**
 * Receipt visibility scope. Restricted users: exact reference allocation or verified attribution
 * only. Client-wide scope (estateFilter null): everything, including UNALLOCATED receipts.
 */
export function receiptScopeClause(estateFilter) {
  if (!estateFilter) return null;
  const ids = Array.isArray(estateFilter) ? estateFilter : [estateFilter];
  return { $or: [{ allocatedEstateId: { $in: ids } }, { attributedEstateId: { $in: ids } }] };
}

export const mpesaTransactionService = {
  async list(clientId, estateFilter, query = {}) {
    const report = await inspectMpesaIndexes();
    if (report?.gates?.canonicalQueryIndexes !== true) {
      throw Errors.ServiceUnavailable('M-PESA receipt query indexes are not ready');
    }

    const { page, limit, skip } = paginationParams(query);
    const filter = { clientId };
    if (query.verificationState) filter.verificationState = query.verificationState;
    if (query.postingState) filter.postingState = query.postingState;
    if (query.businessShortCode) filter.businessShortCode = String(query.businessShortCode);
    if (query.startDate || query.endDate) {
      filter.transactionAt = {};
      if (query.startDate) filter.transactionAt.$gte = new Date(query.startDate);
      if (query.endDate) filter.transactionAt.$lte = new Date(query.endDate);
    }

    if (query.allocationState) filter.allocationState = query.allocationState;

    // Estate-restricted users see ONLY receipts tied to their estate by exact reference
    // allocation or a verified attribution. Membership of a shared merchant in the estate is
    // deliberately NOT a predicate (it would leak every receipt of a shared PayBill/Till to every
    // mapped estate). Unallocated receipts are visible only to the client-wide scope.
    const scope = receiptScopeClause(estateFilter);
    if (scope) Object.assign(filter, scope);

    const [items, total] = await Promise.all([
      MpesaTransaction.find(filter)
        .select('merchantProfileId businessShortCode receiptNumber amountCents currency transactionAt billRefNumber transactionType sourceChannels verificationState conflictReason claimState postingState postedAt attributedEstateId allocationState allocationReason allocatedEstateId createdAt')
        .sort({ transactionAt: -1, _id: -1 })
        .skip(skip)
        .limit(limit)
        .lean(),
      MpesaTransaction.countDocuments(filter),
    ]);
    return paginatedResponse(items.map(toMpesaTransactionDTO), total, { page, limit });
  },

  /**
   * Aggregate receipt metrics for a bounded window. Definitions live in
   * mpesaReceiptSummary.js. Authorization is identical to list(): estate-restricted
   * users only ever aggregate receipts tied to their estate; an estateId query is
   * ANDed with that scope, so it can narrow but never widen it.
   */
  async summary(clientId, estateFilter, query = {}) {
    const report = await inspectMpesaIndexes();
    if (report?.gates?.canonicalQueryIndexes !== true) {
      throw Errors.ServiceUnavailable('M-PESA receipt query indexes are not ready');
    }
    const start = new Date(query.startDate);
    const end = new Date(query.endDate);
    if (Number.isNaN(start.getTime()) || Number.isNaN(end.getTime()) || start > end) {
      throw Errors.InvalidRequest('startDate and endDate are required and startDate must not be after endDate');
    }
    if ((end - start) / 86_400_000 > SUMMARY_MAX_WINDOW_DAYS) {
      throw Errors.InvalidRequest(`The reporting window may not exceed ${SUMMARY_MAX_WINDOW_DAYS} days`);
    }

    const and = [{ clientId, transactionAt: { $gte: start, $lte: end } }];
    const scope = receiptScopeClause(estateFilter);
    if (scope) and.push(scope);
    if (query.estateId) {
      and.push({ $or: [{ allocatedEstateId: query.estateId }, { attributedEstateId: query.estateId }] });
    }

    const rows = await MpesaTransaction.find({ $and: and })
      .select('acceptedAmountCents postingState verificationState allocationState allocatedEstateId attributedEstateId paymentId paymentIds creditEarnedCents')
      .lean()
      .cursor();
    const receipts = [];
    for await (const r of rows) receipts.push(r);
    return {
      window: { startDate: start.toISOString(), endDate: end.toISOString() },
      scope: estateFilter ? 'ESTATE_RESTRICTED' : 'CLIENT_WIDE',
      ...summarizeReceipts(receipts),
    };
  },
};
