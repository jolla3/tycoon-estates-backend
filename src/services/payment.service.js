// src/services/payment.service.js
import mongoose from 'mongoose';
import { Payment } from '../models/Payment.js';
import { House } from '../models/House.js';
import { rentService } from './rent.service.js';
import { dateUtil } from '../utils/date.js';
import { paginationParams, paginatedResponse } from '../utils/pagination.js';
import { estateFilterClause } from '../utils/estateFilter.js';
import { Errors } from '../utils/errors.js';
import { supportsMongoTransactions } from '../config/database.js';
import { audit } from './audit.service.js';
import { tenancyService } from './tenancy.service.js';
import { accountingPostingService } from './accountingPosting.service.js';

export const paymentService = {
  async list(clientId, estateFilter, query) {
    const { page, limit, skip } = paginationParams(query);
    const filter = { clientId, ...estateFilterClause(estateFilter) };
    if (query.houseId) filter.houseId = query.houseId;
    if (query.tenantId) filter.tenantId = query.tenantId;
    if (query.estateId) filter.estateId = query.estateId;

    const [items, total] = await Promise.all([
      Payment.find(filter).sort({ paymentDate: -1 }).skip(skip).limit(limit).lean(),
      Payment.countDocuments(filter),
    ]);
    return paginatedResponse(items, total, { page, limit });
  },

  /**
   * Manual payment entry (cash/M-Pesa recorded by staff).
   * Allocates oldest-first onto outstanding RentCharges, then posts Ledger PAYMENT.
   * Idempotent when paymentReference matches an existing CONFIRMED payment
   * for the same client+house+amount.
   *
   * AUTHORITY:
   * - RentCharge.amountPaidCents / balanceCents = operational allocation cache
   * - Ledger.runningBalanceCents = authoritative account balance
   */
  async recordManual(clientId, body, estateFilter = null, actor = null, reqMeta = {}) {
    const { houseId, amountCents, paymentDate, paymentReference, period, tenantId, tenancyId } = body;
    if (!houseId) throw Errors.InvalidRequest('houseId is required');
    const amount = Math.trunc(Number(amountCents));
    if (!Number.isSafeInteger(amount) || amount <= 0) {
      throw Errors.InvalidRequest('amountCents must be a positive integer');
    }
    const payDate = paymentDate ? new Date(paymentDate) : new Date();
    if (Number.isNaN(payDate.getTime())) throw Errors.InvalidRequest('paymentDate is not a valid date');

    const house = await House.findOne({
      _id: houseId,
      clientId,
      ...estateFilterClause(estateFilter),
    });
    if (!house) throw Errors.HouseNotFound();

    if (supportsMongoTransactions() !== true) {
      throw Errors.ServiceUnavailable('MongoDB transactions required for financial posting');
    }
    const payPeriod = period || dateUtil.currentPeriod();

    // One validated tenancy drives charges, Payment.tenancyId, allocations and the
    // ledger entry. The tenant comes from that tenancy, never from house.tenantId.
    const session = await mongoose.startSession();
    let result;
    let tenancy;
    try {
      await session.withTransaction(async () => {
        tenancy = await tenancyService.resolveForManualPayment(
          clientId, house, { period: payPeriod, tenancyId, tenantId }, { session }
        );
        await rentService.ensureChargesForTenancy(clientId, tenancy, house, payPeriod, { session });
        const outstanding = await rentService.outstandingChargesForTenancy(clientId, tenancy._id, { session });
        result = await accountingPostingService.postConfirmedPayment({
          clientId,
          estateId: tenancy.estateId,
          houseId: house._id,
          tenantId: tenancy.tenantId,
          tenancyId: tenancy._id,
          amountCents: amount,
          paymentDate: payDate,
          paymentDateWasExplicit: Boolean(paymentDate),
          paymentReference: paymentReference || null,
          period: payPeriod,
          origin: 'MANUAL',
          tenderMethod: body.tenderMethod || null,
          recordedByUserId: actor?._id || null,
          evidenceReference: paymentReference || body.evidenceReference || null,
          charges: outstanding,
        }, { session });
      });
    } finally {
      await session.endSession();
    }

    await audit({
      clientId,
      estateId: house.estateId,
      userId: actor?._id,
      action: 'PAYMENT_RECORDED',
      resource: 'Payment',
      resourceId: result.payment._id,
      description: `Manual payment ${amount} cents for house ${house.houseNumber}`,
      metadata: { amountCents: amount, reused: result.reused, tenancyId: String(tenancy._id), period: payPeriod },
      ipAddress: reqMeta.ip,
      userAgent: reqMeta.userAgent,
    });

    return result;
  },

  /** Choices for the manual-payment form (human-readable tenancies for a house + period). */
  async manualOptions(clientId, estateFilter, { houseId, period, page, limit, search }) {
    const house = await House.findOne({ _id: houseId, clientId, ...estateFilterClause(estateFilter) });
    if (!house) throw Errors.HouseNotFound();
    return tenancyService.manualPaymentOptions(clientId, house, period || dateUtil.currentPeriod(), { page, limit, search });
  },
};
