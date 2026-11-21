// src/services/payment.service.js
import crypto from 'crypto';
import mongoose from 'mongoose';
import { Payment } from '../models/Payment.js';
import { House } from '../models/House.js';
import { Tenant } from '../models/Tenant.js';
import { dateUtil } from '../utils/date.js';
import { paginationParams, paginatedResponse } from '../utils/pagination.js';
import { estateFilterClause } from '../utils/estateFilter.js';
import { Errors } from '../utils/errors.js';
import { supportsMongoTransactions } from '../config/database.js';
import { audit } from './audit.service.js';
import { tenancyService } from './tenancy.service.js';
import { settleTenantAccount, tenantAccountSnapshot } from './tenantCredit.service.js';

/**
 * Stable identity for a manual receipt (idempotency).
 * Prefer operator reference when present; otherwise a content hash so retries
 * without a reference still reuse the original result within the same details.
 */
function manualIdentityKey({
  clientId, houseId, amountCents, paymentDateStr, tenderMethod, paymentReference, actorId,
}) {
  if (paymentReference && String(paymentReference).trim()) {
    return `ref:${clientId}:${String(paymentReference).trim()}`;
  }
  const material = [
    String(clientId),
    String(houseId),
    String(amountCents),
    String(paymentDateStr),
    String(tenderMethod),
    String(actorId || 'anon'),
  ].join('|');
  const digest = crypto.createHash('sha256').update(material).digest('hex').slice(0, 32);
  return `content:${digest}`;
}

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
   * Ordinary manual payment: house + amount + Nairobi payment date + tender method.
   * Backend resolves occupancy tenant from the payment date, then settles the
   * tenant account (existing credit first, then receipt) across the tenant's
   * eligible obligations in the same client+estate. Does not generate RentCharges.
   */
  async recordManual(clientId, body, estateFilter = null, actor = null, reqMeta = {}) {
    const { houseId, amountCents, paymentDate, paymentReference, period, tenantId, tenancyId, tenderMethod } = body;
    if (!houseId) throw Errors.InvalidRequest('houseId is required');
    const amount = Math.trunc(Number(amountCents));
    if (!Number.isSafeInteger(amount) || amount <= 0) {
      throw Errors.InvalidRequest('amountCents must be a positive integer');
    }
    if (!paymentDate) throw Errors.InvalidRequest('paymentDate is required');
    if (!tenderMethod) throw Errors.InvalidRequest('tenderMethod is required');

    // Parse as Nairobi calendar date (never `new Date('YYYY-MM-DD')`).
    const nairobi = dateUtil.parseNairobiDateOnly(paymentDate);
    if (!nairobi) {
      throw Errors.InvalidRequest('paymentDate must be a valid YYYY-MM-DD Nairobi calendar date');
    }
    const payDate = nairobi.noon; // stable instant within the Nairobi day for storage

    const house = await House.findOne({
      _id: houseId,
      clientId,
      ...estateFilterClause(estateFilter),
    });
    if (!house) throw Errors.HouseNotFound();

    if (supportsMongoTransactions() !== true) {
      throw Errors.ServiceUnavailable('MongoDB transactions required for financial posting');
    }

    // Authoritative current occupancy (never trust prior context response).
    const occupancy = await tenancyService.resolveOccupancyForManualPayment(
      clientId, house, nairobi
    );
    if (!occupancy.ok) {
      throw Errors.InvalidRequest(occupancy.reason || 'House is not eligible for ordinary payment recording');
    }

    // Historical covering tenancy for the payment date (may differ from active).
    const covering = occupancy.tenancy;
    if (tenantId && String(covering.tenantId) !== String(tenantId)) {
      throw Errors.InvalidRequest('tenantId does not match the occupant on the payment date');
    }
    if (tenancyId && String(covering._id) !== String(tenancyId)) {
      throw Errors.InvalidRequest('tenancyId does not match the covering tenancy for the payment date');
    }

    const identityKey = manualIdentityKey({
      clientId,
      houseId: house._id,
      amountCents: amount,
      paymentDateStr: nairobi.dateStr,
      tenderMethod,
      paymentReference: paymentReference || null,
      actorId: actor?._id,
    });

    const session = await mongoose.startSession();
    let settled;
    let tenantDoc = null;
    let balanceBefore = null;
    try {
      await session.withTransaction(async () => {
        // Re-validate occupancy inside the transaction.
        const occTx = await tenancyService.resolveOccupancyForManualPayment(
          clientId, house, nairobi, { session }
        );
        if (!occTx.ok || String(occTx.tenancy._id) !== String(covering._id)) {
          throw Errors.Conflict('House occupancy changed during payment recording');
        }

        tenantDoc = await Tenant.findOne({
          _id: covering.tenantId,
          clientId,
          estateId: covering.estateId,
        }).session(session).lean();
        if (!tenantDoc) {
          throw Errors.InvalidRequest('Resolved tenant does not belong to this client and estate');
        }

        balanceBefore = await tenantAccountSnapshot({
          clientId,
          estateId: covering.estateId,
          tenantId: covering.tenantId,
        }, { session });

        // Tenant-wide settlement: existing credit first, then this receipt. No charge generation.
        settled = await settleTenantAccount({
          clientId,
          estateId: covering.estateId,
          tenantId: covering.tenantId,
          receipt: {
            source: 'MANUAL',
            identityKey,
            amountCents: amount,
            tenderMethod,
            paymentReference: paymentReference || null,
            houseId: house._id,
            recordedByUserId: actor?._id || null,
            paymentDate: payDate,
          },
          paymentDate: payDate,
          session,
        });
      });
    } finally {
      await session.endSession();
    }

    const balanceAfter = await tenantAccountSnapshot({
      clientId,
      estateId: covering.estateId,
      tenantId: covering.tenantId,
    });

    const primaryPayment = settled.receiptPayments?.[0] || settled.creditPayments?.[0] || null;

    await audit({
      clientId,
      estateId: house.estateId,
      userId: actor?._id,
      action: 'PAYMENT_RECORDED',
      resource: 'Payment',
      resourceId: primaryPayment?._id,
      description: `Manual payment ${amount} cents for house ${house.houseNumber}`,
      metadata: {
        amountCents: amount,
        reused: Boolean(settled.reused),
        occupancyTenancyId: String(covering._id),
        tenantId: String(covering.tenantId),
        tenderMethod,
        paymentDate: nairobi.dateStr,
        identityKey,
        creditAppliedCents: settled.plan?.creditAppliedCents,
        receiptAppliedCents: settled.plan?.receiptAppliedCents,
        newCreditCents: settled.plan?.newCreditCents,
        receiptPaymentIds: (settled.receiptPayments || []).map((p) => String(p._id)),
      },
      ipAddress: reqMeta.ip,
      userAgent: reqMeta.userAgent,
    });

    return {
      payment: primaryPayment,
      payments: settled.receiptPayments || [],
      creditPayments: settled.creditPayments || [],
      allocations: [], // allocations live on child payments; detailed list optional for UI
      reused: Boolean(settled.reused),
      tenancyId: covering._id,
      tenantId: covering.tenantId,
      unappliedCents: settled.plan?.newCreditCents ?? 0,
      remainingBalanceCents: balanceAfter.netCents,
      balanceBeforeCents: balanceBefore.netCents,
      balanceAfterCents: balanceAfter.netCents,
      creditBeforeCents: balanceBefore.creditCents,
      creditAfterCents: balanceAfter.creditCents,
      outstandingBeforeCents: balanceBefore.outstandingCents,
      outstandingAfterCents: balanceAfter.outstandingCents,
      plan: settled.plan,
      tenant: tenantDoc
        ? { _id: String(tenantDoc._id), name: tenantDoc.name, phone: tenantDoc.phone }
        : null,
    };
  },

  async manualOptions(clientId, estateFilter, { houseId, period, page, limit, search, eligiblePage, eligibleLimit, eligibleSearch }) {
    const house = await House.findOne({ _id: houseId, clientId, ...estateFilterClause(estateFilter) });
    if (!house) throw Errors.HouseNotFound();
    return tenancyService.manualPaymentOptions(clientId, house, period || dateUtil.currentPeriod(), { page, limit, search, eligiblePage, eligibleLimit, eligibleSearch });
  },

  /**
   * Occupancy + tenant-wide balance for the Record Payment form.
   */
  async manualContext(clientId, estateFilter, { houseId, paymentDate }) {
    const house = await House.findOne({
      _id: houseId,
      clientId,
      ...estateFilterClause(estateFilter),
    }).lean();
    if (!house) throw Errors.HouseNotFound();

    let nairobi;
    if (paymentDate) {
      nairobi = dateUtil.parseNairobiDateOnly(paymentDate);
      if (!nairobi) throw Errors.InvalidRequest('paymentDate must be a valid YYYY-MM-DD Nairobi calendar date');
    } else {
      const today = dateUtil.today();
      nairobi = dateUtil.parseNairobiDateOnly(today);
    }

    const occupancy = await tenancyService.resolveOccupancyForManualPayment(clientId, house, nairobi);

    let tenantBalanceCents = null;
    let tenant = null;
    let creditCents = null;
    let outstandingCents = null;

    if (occupancy.ok && occupancy.tenancy) {
      const t = await Tenant.findOne({
        _id: occupancy.tenancy.tenantId,
        clientId,
        estateId: occupancy.tenancy.estateId,
      }).lean();
      if (t) {
        tenant = { _id: String(t._id), name: t.name, phone: t.phone, status: t.status };
        const snap = await tenantAccountSnapshot({
          clientId,
          estateId: occupancy.tenancy.estateId,
          tenantId: occupancy.tenancy.tenantId,
        });
        tenantBalanceCents = snap.netCents;
        creditCents = snap.creditCents;
        outstandingCents = snap.outstandingCents;
      }
    }

    return {
      houseId: String(house._id),
      houseNumber: house.houseNumber,
      houseStatus: house.status,
      isActive: house.isActive !== false,
      paymentDate: nairobi.dateStr,
      occupancy: {
        ok: occupancy.ok,
        reason: occupancy.reason,
        tenancyId: occupancy.tenancy ? String(occupancy.tenancy._id) : null,
        tenantId: occupancy.tenancy ? String(occupancy.tenancy.tenantId) : null,
      },
      tenant,
      // Tenant-wide net (credit - outstanding). null only when tenant cannot be resolved.
      tenantBalanceCents,
      creditCents,
      outstandingCents,
    };
  },
};
