// src/services/transaction.service.js
import { BankTransaction } from '../models/BankTransaction.js';
import { House } from '../models/House.js';
import { Tenant } from '../models/Tenant.js';
import { rentService } from './rent.service.js';
import { reconciliationService } from './reconciliation.service.js';
import { smsService } from './sms.service.js';
import { paginationParams, paginatedResponse } from '../utils/pagination.js';
import { dateUtil } from '../utils/date.js';
import { Errors } from '../utils/errors.js';
import { estateFilterClause } from '../utils/estateFilter.js';
import mongoose from 'mongoose';

export const transactionService = {
  async list(clientId, estateFilter, query) {
    const { page, limit, skip } = paginationParams(query);
    const filter = { clientId, ...estateFilterClause(estateFilter) };
    if (query.matchStatus) filter.matchStatus = query.matchStatus;
    if (query.startDate) {
      const start = new Date(query.startDate);
      if (Number.isNaN(start.getTime())) throw Errors.InvalidRequest('startDate is not a valid date');
      filter.transactionDate = { ...(filter.transactionDate || {}), $gte: start };
    }
    if (query.endDate) {
      const end = new Date(query.endDate);
      if (Number.isNaN(end.getTime())) throw Errors.InvalidRequest('endDate is not a valid date');
      filter.transactionDate = { ...(filter.transactionDate || {}), $lte: end };
    }

    const [items, total] = await Promise.all([
      BankTransaction.find(filter).sort({ transactionDate: -1 }).skip(skip).limit(limit),
      BankTransaction.countDocuments(filter),
    ]);
    return paginatedResponse(items, total, { page, limit });
  },

  /** Section 20: dedicated unmatched-transactions view for admin review. */
  unmatched: (clientId, estateFilter) => BankTransaction.find({ clientId, ...estateFilterClause(estateFilter), matchStatus: 'UNMATCHED' }).sort({ transactionDate: -1 }),

  /** Manual admin assignment of an UNMATCHED transaction to a house (section 12/20). Both the transaction and the target house are re-verified against clientId — a house belonging to a different client can never be assigned to, even by guessing its _id. Same atomicity guarantee as the automatic reconcile() path: Payment + RentCharge + BankTransaction.matchStatus are written in one Mongo transaction. */
  async assignToHouse(clientId, transactionId, houseId, estateFilter = null) {
    const bankTransaction = await BankTransaction.findOne({
      _id: transactionId,
      clientId,
      ...estateFilterClause(estateFilter),
    });
    if (!bankTransaction) throw Errors.PaymentNotFound('Transaction not found');
    if (bankTransaction.matchStatus === 'MATCHED') throw Errors.TransactionAlreadyProcessed('Transaction already matched');

    const house = await House.findOne({
      _id: houseId,
      clientId,
      ...estateFilterClause(estateFilter),
    });
    if (!house) throw Errors.HouseNotFound();

    const tenant = house.tenantId
      ? await Tenant.findOne({ _id: house.tenantId, clientId, ...estateFilterClause(estateFilter) })
      : null;
    const period = dateUtil.periodOf(bankTransaction.transactionDate);

    const session = await mongoose.startSession();
    let rentCharge;
    try {
      await session.withTransaction(async () => {
        await rentService.ensureChargesForHouse(clientId, house, tenant, period, { session });
        await reconciliationService.applyPayment({ bankTransaction, house, tenant, period, session });

        bankTransaction.matchedHouseId = house._id;
        bankTransaction.matchedTenantId = tenant?._id || null;
        bankTransaction.matchStatus = 'MATCHED';
        await bankTransaction.save({ session });
      });
    } finally {
      await session.endSession();
    }

    // Post-commit only — see reconciliationService.reconcile() for why.
    if (tenant?.phone) {
      await smsService.sendPaymentConfirmation({
        clientId,
        estateId: house.estateId,
        tenantId: tenant._id,
        houseId: house._id,
        phone: tenant.phone,
        tenantName: tenant.name,
        houseNumber: house.houseNumber,
        amountCents: bankTransaction.amountCents,
        balanceCents: Math.max(rentCharge.balanceCents, 0),
      });
    }

    return bankTransaction;
  },
};
