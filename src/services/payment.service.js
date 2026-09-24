// src/services/payment.service.js
import mongoose from 'mongoose';
import { Payment } from '../models/Payment.js';
import { PaymentAllocation } from '../models/PaymentAllocation.js';
import { House } from '../models/House.js';
import { Tenant } from '../models/Tenant.js';
import { rentService } from './rent.service.js';
import { ledgerService } from './ledger.service.js';
import { planAllocation, statusAfterPayment } from '../utils/allocation.js';
import { money } from '../utils/money.js';
import { dateUtil } from '../utils/date.js';
import { paginationParams, paginatedResponse } from '../utils/pagination.js';
import { estateFilterClause } from '../utils/estateFilter.js';
import { Errors } from '../utils/errors.js';
import { supportsMongoTransactions } from '../config/database.js';
import { audit } from './audit.service.js';

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
    const { houseId, amountCents, paymentDate, paymentReference, period, tenantId } = body;
    if (!houseId) throw Errors.InvalidRequest('houseId is required');
    const amount = Math.trunc(Number(amountCents));
    if (!Number.isFinite(amount) || amount <= 0) {
      throw Errors.InvalidRequest('amountCents must be a positive integer');
    }

    const house = await House.findOne({
      _id: houseId,
      clientId,
      ...estateFilterClause(estateFilter),
    });
    if (!house) throw Errors.HouseNotFound();

    let tenant = null;
    if (tenantId) {
      tenant = await Tenant.findOne({
        _id: tenantId,
        clientId,
        ...estateFilterClause(estateFilter),
      });
      if (!tenant) throw Errors.TenantNotFound();
    } else if (house.tenantId) {
      tenant = await Tenant.findOne({ _id: house.tenantId, clientId });
    }

    const payPeriod = period || dateUtil.currentPeriod();
    const payDate = paymentDate ? new Date(paymentDate) : new Date();

    // Soft idempotency: same client + house + reference + amount
    if (paymentReference) {
      const existing = await Payment.findOne({
        clientId,
        houseId,
        paymentReference,
        amountCents: amount,
        status: 'CONFIRMED',
      }).lean();
      if (existing) {
        return { payment: existing, allocations: [], reused: true };
      }
    }

    const run = async (session) => {
      const charges = await rentService.outstandingChargesForHouse(clientId, house._id, {
        session,
      });
      if (tenant || house.status === 'occupied') {
        await rentService.ensureChargesForHouse(clientId, house, tenant, payPeriod, { session });
      }
      const allOutstanding = await rentService.outstandingChargesForHouse(clientId, house._id, {
        session,
      });

      const plan = planAllocation(allOutstanding, amount);
      const primaryPeriod = plan[0]?.charge?.period || payPeriod;

      const [payment] = await Payment.create(
        [
          {
            clientId,
            estateId: house.estateId,
            houseId: house._id,
            tenantId: tenant?._id || null,
            amountCents: amount,
            paymentDate: payDate,
            paymentReference: paymentReference || null,
            period: primaryPeriod,
            status: 'CONFIRMED',
          },
        ],
        session ? { session } : undefined
      );

      const allocationDocs = [];
      for (const slice of plan) {
        const charge = slice.charge;
        // Operational cache on RentCharge (not authoritative balance)
        charge.amountPaidCents = money.add(charge.amountPaidCents || 0, slice.amountCents);
        charge.balanceCents = money.subtract(charge.amountDueCents, charge.amountPaidCents);
        charge.status = statusAfterPayment(charge.amountDueCents, charge.amountPaidCents);
        await charge.save(session ? { session } : undefined);

        allocationDocs.push({
          clientId,
          estateId: house.estateId,
          paymentId: payment._id,
          rentChargeId: charge._id,
          amountCents: slice.amountCents,
          chargeType: charge.chargeType || 'RENT',
          period: charge.period,
        });
      }
      if (allocationDocs.length) {
        await PaymentAllocation.create(allocationDocs, session ? { session } : undefined);
      }

      // Authoritative financial movement
      await ledgerService.postEntry(
        {
          clientId,
          estateId: house.estateId,
          houseId: house._id,
          tenantId: tenant?._id || null,
          entryType: 'PAYMENT',
          amountCents: amount, // credit
          referenceType: 'Payment',
          referenceId: payment._id,
          description: paymentReference
            ? `Manual payment ${paymentReference}`
            : 'Manual payment',
          period: primaryPeriod,
        },
        { session }
      );

      return { payment, allocations: allocationDocs, reused: false };
    };

    let result;
    if (supportsMongoTransactions()) {
      const session = await mongoose.startSession();
      session.startTransaction();
      try {
        result = await run(session);
        await session.commitTransaction();
      } catch (err) {
        await session.abortTransaction();
        throw err;
      } finally {
        session.endSession();
      }
    } else {
      result = await run(null);
    }

    await audit({
      clientId,
      estateId: house.estateId,
      userId: actor?._id,
      action: 'PAYMENT_RECORDED',
      resource: 'Payment',
      resourceId: result.payment._id,
      description: `Manual payment ${amount} cents for house ${house.houseNumber}`,
      metadata: { amountCents: amount, reused: result.reused },
      ipAddress: reqMeta.ip,
      userAgent: reqMeta.userAgent,
    });

    return result;
  },
};
