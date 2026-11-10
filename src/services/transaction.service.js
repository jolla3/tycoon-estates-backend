// src/services/transaction.service.js
import { BankTransaction } from '../models/BankTransaction.js';
import { House } from '../models/House.js';
import { Tenant } from '../models/Tenant.js';
import { reconciliationService } from './reconciliation.service.js';
import { smsService } from './sms.service.js';
import { paginationParams, paginatedResponse } from '../utils/pagination.js';
import { dateUtil } from '../utils/date.js';
import { Errors } from '../utils/errors.js';
import { estateFilterClause } from '../utils/estateFilter.js';
import mongoose from 'mongoose';
import { tenancyService } from './tenancy.service.js';

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
    if (bankTransaction.eventType !== 'CREDIT') {
      throw Errors.InvalidRequest('Only CREDIT bank transactions can be assigned as payments');
    }
    if (!Number.isSafeInteger(bankTransaction.amountCents) || bankTransaction.amountCents <= 0) {
      throw Errors.InvalidRequest('Bank transaction amountCents must be a positive safe integer');
    }

    const house = await House.findOne({
      _id: houseId,
      clientId,
      estateId: bankTransaction.estateId,
      ...estateFilterClause(estateFilter),
    });
    if (!house) throw Errors.HouseNotFound();

    const period = dateUtil.periodOf(bankTransaction.transactionDate);

    const tenancy = await tenancyService.findUniqueForHouseAt(
      clientId, house._id, bankTransaction.transactionDate
    );
    if (!tenancy || String(tenancy.estateId) !== String(bankTransaction.estateId)
      || String(tenancy.houseId) !== String(house._id)) {
      throw Errors.InvalidRequest('No unique tenancy for this house/estate at the transaction date');
    }
    // Tenant estateId is its current location and may differ from a closed
    // historical Tenancy after a transfer. Trust the Tenancy's immutable scope.
    const tenant = await Tenant.findOne({ _id: tenancy.tenantId, clientId });
    if (!tenant) throw Errors.TenantNotFound();
    const session = await mongoose.startSession();
    let remainingBalanceCents = 0;
    try {
      await session.withTransaction(async () => {
        const result = await reconciliationService.applyPayment({
          bankTransaction, house, tenant, period, session, tenancyId: tenancy._id,
        });
        remainingBalanceCents = result.remainingBalanceCents ?? 0;
        bankTransaction.matchedHouseId = house._id;
        bankTransaction.matchedTenantId = tenant?._id || null;
        bankTransaction.matchedTenancyId = tenancy._id;
        bankTransaction.matchStatus = 'MATCHED';
        bankTransaction.processingState = 'POSTED';
        bankTransaction.lastProcessingError = null;
        await bankTransaction.save({ session });
      });
    } finally {
      await session.endSession();
    }
    if (tenant?.phone) {
      await smsService.sendPaymentConfirmation({
        clientId, estateId: house.estateId, tenantId: tenant._id, houseId: house._id,
        phone: tenant.phone, tenantName: tenant.name, houseNumber: house.houseNumber,
        amountCents: bankTransaction.amountCents,
        balanceCents: Math.max(remainingBalanceCents, 0),
      });
    }
    return bankTransaction;
  },
};
