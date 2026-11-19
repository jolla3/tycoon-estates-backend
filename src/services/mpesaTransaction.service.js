import { MpesaTransaction } from '../models/MpesaTransaction.js';
import { MpesaMerchantProfile } from '../models/MpesaMerchantProfile.js';
import { paginationParams, paginatedResponse } from '../utils/pagination.js';
import { estateFilterClause } from '../utils/estateFilter.js';
import { inspectMpesaIndexes } from '../utils/mpesaIndexReadiness.js';
import { Errors } from '../utils/errors.js';
import { toMpesaTransactionDTO } from '../utils/mpesaTransactionDto.js';

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

    // Resolve estate access through client-owned merchant profiles, and include
    // receipts already attributed to the same estate. clientId remains mandatory.
    if (estateFilter) {
      const profiles = await MpesaMerchantProfile.find({
        clientId,
        ...estateFilterClause(estateFilter),
      }).select('_id').lean();
      const profileIds = profiles.map((p) => p._id);
      const attributedClause = Array.isArray(estateFilter)
        ? { attributedEstateId: { $in: estateFilter } }
        : { attributedEstateId: estateFilter };
      const scopes = [attributedClause];
      if (profileIds.length) scopes.push({ merchantProfileId: { $in: profileIds } });
      filter.$or = scopes;
    }

    const [items, total] = await Promise.all([
      MpesaTransaction.find(filter)
        .select('merchantProfileId businessShortCode receiptNumber amountCents currency transactionAt billRefNumber transactionType sourceChannels verificationState conflictReason claimState postingState postedAt attributedEstateId createdAt')
        .sort({ transactionAt: -1, _id: -1 })
        .skip(skip)
        .limit(limit)
        .lean(),
      MpesaTransaction.countDocuments(filter),
    ]);
    return paginatedResponse(items.map(toMpesaTransactionDTO), total, { page, limit });
  },
};
