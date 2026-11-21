// src/services/payment.service.js
import mongoose from 'mongoose';
import { Payment } from '../models/Payment.js';
import { House } from '../models/House.js';
import { Tenant } from '../models/Tenant.js';
import { rentService } from './rent.service.js';
import { dateUtil } from '../utils/date.js';
import { paginationParams, paginatedResponse } from '../utils/pagination.js';
import { estateFilterClause } from '../utils/estateFilter.js';
import { Errors } from '../utils/errors.js';
import { supportsMongoTransactions } from '../config/database.js';
import { audit } from './audit.service.js';
import { tenancyService } from './tenancy.service.js';
import { accountingPostingService } from './accountingPosting.service.js';
import { ledgerService } from './ledger.service.js';

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
   * Ordinary flow: houseId + amount + paymentDate + tenderMethod.
   * Backend resolves House → tenancy covering paymentDate → tenant.
   * Allocates oldest-first onto that tenancy's outstanding RentCharges, then posts Ledger PAYMENT.
   * Idempotent when paymentReference matches an existing CONFIRMED payment
   * for the same client+house+amount.
   */
  async recordManual(clientId, body, estateFilter = null, actor = null, reqMeta = {}) {
    const { houseId, amountCents, paymentDate, paymentReference, period, tenantId, tenancyId, tenderMethod } = body;
    if (!houseId) throw Errors.InvalidRequest('houseId is required');
    const amount = Math.trunc(Number(amountCents));
    if (!Number.isSafeInteger(amount) || amount <= 0) {
      throw Errors.InvalidRequest('amountCents must be a positive integer');
    }
    if (!paymentDate) throw Errors.InvalidRequest('paymentDate is required');
    const payDate = new Date(paymentDate);
    if (Number.isNaN(payDate.getTime())) throw Errors.InvalidRequest('paymentDate is not a valid date');
    if (!tenderMethod) throw Errors.InvalidRequest('tenderMethod is required');

    const house = await House.findOne({
      _id: houseId,
      clientId,
      ...estateFilterClause(estateFilter),
    });
    if (!house) throw Errors.HouseNotFound();

    if (supportsMongoTransactions() !== true) {
      throw Errors.ServiceUnavailable('MongoDB transactions required for financial posting');
    }

    const session = await mongoose.startSession();
    let result;
    let tenancy;
    let tenantDoc = null;
    let balanceBeforeCents = null;
    try {
      await session.withTransaction(async () => {
        tenancy = await tenancyService.resolveForManualPayment(
          clientId,
          house,
          {
            paymentDate: payDate,
            period: period || null,
            tenancyId: tenancyId || null,
            tenantId: tenantId || null,
          },
          { session }
        );

        tenantDoc = await Tenant.findOne({
          _id: tenancy.tenantId,
          clientId,
        }).session(session).lean();
        if (!tenantDoc) {
          throw Errors.InvalidRequest('Resolved tenant does not belong to this client');
        }
        if (String(tenantDoc.estateId) !== String(tenancy.estateId)) {
          throw Errors.InvalidRequest('Tenant estate does not match the tenancy estate');
        }

        balanceBeforeCents = await ledgerService.currentBalanceForTenancy(
          clientId, tenancy._id, 'RENT', { session }
        );

        // Ensure charges exist for the payment's calendar period only as a side effect of
        // existing billing; do not invent a new RentCharge just because money arrived.
        const payPeriod = period || dateUtil.periodFromDate(payDate) || dateUtil.currentPeriod();
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
          paymentDateWasExplicit: true,
          paymentReference: paymentReference || null,
          period: payPeriod,
          origin: 'MANUAL',
          tenderMethod: tenderMethod || null,
          recordedByUserId: actor?._id || null,
          evidenceReference: paymentReference || body.evidenceReference || null,
          charges: outstanding,
        }, { session });
      });
    } finally {
      await session.endSession();
    }

    const balanceAfterCents = result.remainingBalanceCents ?? null;

    await audit({
      clientId,
      estateId: house.estateId,
      userId: actor?._id,
      action: 'PAYMENT_RECORDED',
      resource: 'Payment',
      resourceId: result.payment._id,
      description: `Manual payment ${amount} cents for house ${house.houseNumber}`,
      metadata: {
        amountCents: amount,
        reused: result.reused,
        tenancyId: String(tenancy._id),
        tenantId: String(tenancy.tenantId),
        tenderMethod,
        paymentDate: payDate.toISOString(),
      },
      ipAddress: reqMeta.ip,
      userAgent: reqMeta.userAgent,
    });

    return {
      ...result,
      balanceBeforeCents,
      balanceAfterCents,
      tenant: tenantDoc
        ? { _id: String(tenantDoc._id), name: tenantDoc.name, phone: tenantDoc.phone }
        : null,
    };
  },

  /** Choices for the legacy manual-payment form (tenancy history by period). */
  async manualOptions(clientId, estateFilter, { houseId, period, page, limit, search, eligiblePage, eligibleLimit, eligibleSearch }) {
    const house = await House.findOne({ _id: houseId, clientId, ...estateFilterClause(estateFilter) });
    if (!house) throw Errors.HouseNotFound();
    return tenancyService.manualPaymentOptions(clientId, house, period || dateUtil.currentPeriod(), { page, limit, search, eligiblePage, eligibleLimit, eligibleSearch });
  },

  /**
   * Occupancy + tenant balance for the simplified Record Payment form.
   * Only active, currently occupied houses with a consistent canonical active tenancy.
   */
  async manualContext(clientId, estateFilter, { houseId, paymentDate }) {
    const house = await House.findOne({
      _id: houseId,
      clientId,
      ...estateFilterClause(estateFilter),
    }).lean();
    if (!house) throw Errors.HouseNotFound();

    const at = paymentDate ? new Date(paymentDate) : new Date();
    if (Number.isNaN(at.getTime())) throw Errors.InvalidRequest('paymentDate is not a valid date');

    const occupancy = await tenancyService.resolveOccupancyForManualPayment(clientId, house, at);

    let tenantBalanceCents = null;
    let tenant = null;
    if (occupancy.ok && occupancy.tenancy) {
      const t = await Tenant.findOne({ _id: occupancy.tenancy.tenantId, clientId }).lean();
      if (t) {
        tenant = { _id: String(t._id), name: t.name, phone: t.phone, status: t.status };
        tenantBalanceCents = await ledgerService.currentBalanceForTenancy(
          clientId, occupancy.tenancy._id, 'RENT'
        );
      }
    }

    return {
      houseId: String(house._id),
      houseNumber: house.houseNumber,
      houseStatus: house.status,
      isActive: house.isActive !== false,
      paymentDate: at.toISOString(),
      occupancy: {
        ok: occupancy.ok,
        reason: occupancy.reason,
        tenancyId: occupancy.tenancy ? String(occupancy.tenancy._id) : null,
        tenantId: occupancy.tenancy ? String(occupancy.tenancy.tenantId) : null,
      },
      tenant,
      // Tenant financial account (ledger sum for the covering tenancy). null when unknown.
      // Never substitute 0 for unavailable.
      tenantBalanceCents,
    };
  },
};
