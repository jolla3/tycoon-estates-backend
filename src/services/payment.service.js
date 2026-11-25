// src/services/payment.service.js
import mongoose from 'mongoose';
import { Payment } from '../models/Payment.js';
import { PaymentAllocation } from '../models/PaymentAllocation.js';
import { ManualReceipt } from '../models/ManualReceipt.js';
import { TenantCreditMovement } from '../models/TenantCreditMovement.js';
import { House } from '../models/House.js';
import { Tenant } from '../models/Tenant.js';
import { Tenancy } from '../models/Tenancy.js';
import { dateUtil } from '../utils/date.js';
import { paginationParams, paginatedResponse } from '../utils/pagination.js';
import { estateFilterClause } from '../utils/estateFilter.js';
import { Errors } from '../utils/errors.js';
import { supportsMongoTransactions } from '../config/database.js';
import { audit } from './audit.service.js';
import { tenancyService } from './tenancy.service.js';
import { settleTenantAccount, tenantAccountSnapshot } from './tenantCredit.service.js';
import { assertManualReceiptIndexesAligned } from '../utils/manualReceiptIndexReadiness.js';
import { paymentReceiptReadModelService } from './paymentReceiptReadModel.service.js';
import { rentService } from './rent.service.js';

function normalizeReference(value) {
  const s = value == null ? '' : String(value).trim();
  return s || null;
}

function normalizeIdempotencyKey(value) {
  const s = value == null ? '' : String(value).trim();
  if (!s || s.length < 8 || s.length > 128) return null;
  return s;
}

function payloadMatchesReceipt(receipt, {
  houseId, tenantId, tenancyId, amountCents, paymentDateLocal, tenderMethod, paymentReference,
}) {
  return String(receipt.houseId) === String(houseId)
    && String(receipt.tenantId) === String(tenantId)
    && String(receipt.occupancyTenancyId) === String(tenancyId)
    && Number(receipt.amountCents) === Number(amountCents)
    && String(receipt.paymentDateLocal) === String(paymentDateLocal)
    && String(receipt.tenderMethod) === String(tenderMethod)
    && String(receipt.paymentReference || '') === String(paymentReference || '');
}

function receiptSummary(receiptDoc) {
  return {
    _id: String(receiptDoc._id),
    houseId: String(receiptDoc.houseId),
    tenantId: String(receiptDoc.tenantId),
    occupancyTenancyId: String(receiptDoc.occupancyTenancyId),
    paymentDateLocal: receiptDoc.paymentDateLocal,
    period: receiptDoc.period,
    tenderMethod: receiptDoc.tenderMethod,
    amountCents: receiptDoc.amountCents,
    paymentReference: receiptDoc.paymentReference || null,
    idempotencyKey: receiptDoc.idempotencyKey,
    creditAppliedCents: receiptDoc.creditAppliedCents || 0,
    receiptAppliedCents: receiptDoc.receiptAppliedCents || 0,
    newCreditCents: receiptDoc.newCreditCents || 0,
  };
}

/**
 * Rebuild settlement details for an existing ManualReceipt without creating records.
 */
async function reconstructSettlementFromReceipt(existing, { session = null } = {}) {
  const paymentIds = existing.paymentIds || [];
  const creditPaymentIds = existing.creditPaymentIds || [];
  const movementIds = existing.creditMovementIds || [];

  const [receiptPayments, creditPayments, movements] = await Promise.all([
    paymentIds.length
      ? Payment.find({ _id: { $in: paymentIds } }).session(session || null)
      : Promise.resolve([]),
    creditPaymentIds.length
      ? Payment.find({ _id: { $in: creditPaymentIds } }).session(session || null)
      : Promise.resolve([]),
    movementIds.length
      ? TenantCreditMovement.find({ _id: { $in: movementIds } }).session(session || null)
      : Promise.resolve([]),
  ]);

  const allPaymentIds = [
    ...receiptPayments.map((p) => p._id),
    ...creditPayments.map((p) => p._id),
  ];
  const allocDocs = allPaymentIds.length
    ? await PaymentAllocation.find({ paymentId: { $in: allPaymentIds } }).session(session || null).lean()
    : [];

  const paymentById = new Map([
    ...receiptPayments.map((p) => [String(p._id), p]),
    ...creditPayments.map((p) => [String(p._id), p]),
  ]);

  const allocations = allocDocs.map((a) => {
    const pay = paymentById.get(String(a.paymentId));
    return {
      paymentId: a.paymentId,
      tenancyId: a.tenancyId,
      houseId: pay?.houseId || null,
      rentChargeId: a.rentChargeId,
      amountCents: a.amountCents,
      chargeType: a.chargeType,
      period: a.period,
      origin: pay?.origin || null,
    };
  });

  return {
    plan: {
      creditAppliedCents: existing.creditAppliedCents || 0,
      receiptAppliedCents: existing.receiptAppliedCents || 0,
      newCreditCents: existing.newCreditCents || 0,
    },
    receiptPayments,
    creditPayments,
    allocations,
    movements,
    reused: true,
  };
}

export const paymentService = {
  /**
   * Operator-facing canonical receipt history.
   * - One row per confirmed ManualReceipt or posted Bank/M-PESA envelope.
   * - Allocation child Payments and CREDIT-origin applications are joined as detail, never listed as receipts.
   * - Unlinked legacy MANUAL Payment rows remain visible but explicitly unverified.
   */
  async list(clientId, estateFilter, query = {}) {
    return paymentReceiptReadModelService.list(clientId, estateFilter, query);
  },

  /**
   * Ordinary manual payment: house + amount + Nairobi payment date + tender method
   * + client-supplied idempotencyKey.
   * Backend resolves occupancy from the payment date, ensures the exact Tenancy's
   * eligible current/next due-day charges in the same transaction, persists a ManualReceipt,
   * then settles the tenant account (existing credit first, then receipt).
   */
  async recordManual(clientId, body, estateFilter = null, actor = null, reqMeta = {}) {
    const {
      houseId, amountCents, paymentDate, paymentReference, period, tenantId, tenancyId,
      tenderMethod, idempotencyKey: rawKey,
    } = body;

    if (!houseId) throw Errors.InvalidRequest('houseId is required');
    if (!tenantId) throw Errors.InvalidRequest('tenantId is required: choose the tenant who paid');
    if (!tenancyId) throw Errors.InvalidRequest('tenancyId is required: choose the tenant\'s tenancy for this house');
    const amount = Math.trunc(Number(amountCents));
    if (!Number.isSafeInteger(amount) || amount <= 0) {
      throw Errors.InvalidRequest('amountCents must be a positive integer');
    }
    if (!paymentDate) throw Errors.InvalidRequest('paymentDate is required');
    if (!tenderMethod) throw Errors.InvalidRequest('tenderMethod is required');

    const idempotencyKey = normalizeIdempotencyKey(rawKey);
    if (!idempotencyKey) {
      throw Errors.InvalidRequest('idempotencyKey is required (8–128 characters)');
    }

    const nairobi = dateUtil.parseNairobiDateOnly(paymentDate);
    if (!nairobi) {
      throw Errors.InvalidRequest('paymentDate must be a valid YYYY-MM-DD Nairobi calendar date');
    }
    const payDate = nairobi.noon;
    const reference = normalizeReference(paymentReference);

    if (period && period !== nairobi.period) {
      throw Errors.InvalidRequest('period does not match the payment date accounting period');
    }

    if (supportsMongoTransactions() !== true) {
      throw Errors.ServiceUnavailable('MongoDB transactions required for financial posting');
    }

    try {
      await assertManualReceiptIndexesAligned();
    } catch (err) {
      if (err?.code === 'MANUAL_RECEIPT_INDEX_NOT_ALIGNED') {
        throw Errors.ServiceUnavailable('Manual receipt identity indexes are not ready');
      }
      throw err;
    }

    const houseProbe = await House.findOne({
      _id: houseId,
      clientId,
      ...estateFilterClause(estateFilter),
    }).lean();
    if (!houseProbe) throw Errors.HouseNotFound();

    const session = await mongoose.startSession();
    let settled = null;
    let receiptDoc = null;
    let tenantDoc = null;
    let covering = null;
    let balanceBefore = null;
    let reused = false;

    try {
      await session.withTransaction(async () => {
        const existing = await ManualReceipt.findOne({
          clientId,
          idempotencyKey,
        }).session(session);

        if (existing) {
          if (!payloadMatchesReceipt(existing, {
            houseId,
            tenantId,
            tenancyId,
            amountCents: amount,
            paymentDateLocal: nairobi.dateStr,
            tenderMethod,
            paymentReference: reference,
          })) {
            throw Errors.Conflict(
              'idempotencyKey was already used with different receipt details'
            );
          }
          receiptDoc = existing;
          reused = true;
          covering = {
            _id: existing.occupancyTenancyId,
            tenantId: existing.tenantId,
            estateId: existing.estateId,
          };
          tenantDoc = await Tenant.findOne({
            _id: existing.tenantId, clientId, estateId: existing.estateId,
          }).session(session).lean();
          balanceBefore = await tenantAccountSnapshot({
            clientId, estateId: existing.estateId, tenantId: existing.tenantId,
          }, { session });
          settled = await reconstructSettlementFromReceipt(existing, { session });
          return;
        }

        if (reference) {
          const refHit = await ManualReceipt.findOne({
            clientId,
            paymentReference: reference,
          }).session(session).select('_id idempotencyKey').lean();
          if (refHit && refHit.idempotencyKey !== idempotencyKey) {
            throw Errors.Conflict('This payment reference was already used by another receipt');
          }

          // ManualReceipt is the canonical store for new receipts, but older
          // manual receipts remain in Payment. Preserve client-wide reference
          // uniqueness across both collections during the transition.
          const legacyPaymentRefHit = await Payment.findOne({
            clientId,
            origin: 'MANUAL',
            paymentReference: reference,
          }).session(session).select('_id').lean();
          if (legacyPaymentRefHit) {
            throw Errors.Conflict('This payment reference was already used by another receipt');
          }
        }

        const houseInTx = await House.findOne({
          _id: houseId,
          clientId,
          ...estateFilterClause(estateFilter),
        }).session(session);
        if (!houseInTx) throw Errors.HouseNotFound();

        // Explicit ownership: validate the operator's tenant/house/tenancy/date; never
        // substitute the house's current occupant.
        const explicit = await tenancyService.resolveExplicitForManualPayment(
          clientId, houseInTx, { tenantId, tenancyId }, nairobi, { session }
        );
        covering = explicit.tenancy;

        tenantDoc = await Tenant.findOne({
          _id: covering.tenantId,
          clientId,
          estateId: covering.estateId,
        }).session(session).lean();
        if (!tenantDoc) {
          throw Errors.InvalidRequest('Resolved tenant does not belong to this client and estate');
        }

        // Generate only this exact Tenancy's currently eligible current/next cycle(s).
        // The payment date selected ownership above; billing uses the current Nairobi
        // cycle so a backdated receipt cannot manufacture historic obligations.
        await rentService.ensureDueDayChargesForTenancy(
          clientId, covering, houseInTx, dateUtil.currentPeriod(), { session }
        );

        balanceBefore = await tenantAccountSnapshot({
          clientId,
          estateId: covering.estateId,
          tenantId: covering.tenantId,
        }, { session });

        const [createdReceipt] = await ManualReceipt.create([{
          clientId,
          estateId: covering.estateId,
          houseId: houseInTx._id,
          tenantId: covering.tenantId,
          occupancyTenancyId: covering._id,
          paymentDateLocal: nairobi.dateStr,
          paymentDate: payDate,
          period: nairobi.period,
          tenderMethod,
          amountCents: amount,
          paymentReference: reference,
          idempotencyKey,
          recordedByUserId: actor?._id || null,
          creditAppliedCents: 0,
          receiptAppliedCents: 0,
          newCreditCents: 0,
          paymentIds: [],
          creditPaymentIds: [],
          creditMovementIds: [],
          status: 'CONFIRMED',
        }], { session });
        receiptDoc = createdReceipt;

        settled = await settleTenantAccount({
          clientId,
          estateId: covering.estateId,
          tenantId: covering.tenantId,
          receipt: {
            source: 'MANUAL',
            identityKey: idempotencyKey,
            amountCents: amount,
            tenderMethod,
            manualReceiptId: createdReceipt._id,
            recordedByUserId: actor?._id || null,
            paymentDate: payDate,
          },
          paymentDate: payDate,
          session,
        });

        createdReceipt.creditAppliedCents = settled.plan?.creditAppliedCents || 0;
        createdReceipt.receiptAppliedCents = settled.plan?.receiptAppliedCents || 0;
        createdReceipt.newCreditCents = settled.plan?.newCreditCents || 0;
        createdReceipt.creditBeforeCents = settled.creditBeforeCents;
        createdReceipt.creditRemainingCents = settled.plan?.creditRemainingCents ?? null;
        createdReceipt.creditAfterCents = settled.creditAfterCents;
        createdReceipt.settlementVersion = 1;
        createdReceipt.paymentIds = (settled.receiptPayments || []).map((p) => p._id);
        createdReceipt.creditPaymentIds = (settled.creditPayments || []).map((p) => p._id);
        createdReceipt.creditMovementIds = (settled.movements || []).map((m) => m._id);
        await createdReceipt.save({ session });

        const applied = createdReceipt.receiptAppliedCents;
        const surplus = createdReceipt.newCreditCents;
        if (applied + surplus !== amount) {
          throw Errors.Conflict('Manual receipt gross amount does not reconcile with settlement');
        }
      });
    } catch (err) {
      if (err?.code === 11000) {
        const key = err?.keyPattern || {};
        if (key.idempotencyKey || (err.message && err.message.includes('idempotency'))) {
          throw Errors.Conflict('idempotencyKey collision while recording receipt');
        }
        if (key.paymentReference || (err.message && err.message.includes('paymentReference'))) {
          throw Errors.Conflict('This payment reference was already used by another receipt');
        }
      }
      throw err;
    } finally {
      await session.endSession();
    }

    const estateId = covering.estateId || receiptDoc.estateId;
    const resolvedTenantId = covering.tenantId || receiptDoc.tenantId;

    const balanceAfter = await tenantAccountSnapshot({
      clientId,
      estateId,
      tenantId: resolvedTenantId,
    });

    await audit({
      clientId,
      estateId,
      userId: actor?._id,
      action: 'PAYMENT_RECORDED',
      resource: 'ManualReceipt',
      resourceId: receiptDoc._id,
      description: `Manual receipt ${amount} cents for house ${houseProbe.houseNumber}`,
      metadata: {
        amountCents: amount,
        reused,
        occupancyTenancyId: String(receiptDoc.occupancyTenancyId),
        tenantId: String(resolvedTenantId),
        tenderMethod,
        paymentDate: nairobi.dateStr,
        period: nairobi.period,
        idempotencyKey,
        creditAppliedCents: settled.plan?.creditAppliedCents,
        receiptAppliedCents: settled.plan?.receiptAppliedCents,
        newCreditCents: settled.plan?.newCreditCents,
        receiptPaymentIds: (settled.receiptPayments || []).map((p) => String(p._id)),
      },
      ipAddress: reqMeta.ip,
      userAgent: reqMeta.userAgent,
    });

    const primaryPayment = settled.receiptPayments?.[0] || null;

    return {
      receipt: receiptSummary(receiptDoc),
      payment: primaryPayment,
      payments: settled.receiptPayments || [],
      creditPayments: settled.creditPayments || [],
      allocations: settled.allocations || [],
      movements: settled.movements || [],
      reused,
      tenancyId: receiptDoc.occupancyTenancyId,
      tenantId: resolvedTenantId,
      unappliedCents: settled.plan?.newCreditCents ?? 0,
      remainingBalanceCents: balanceAfter.netCents,
      balanceBeforeCents: balanceBefore?.netCents ?? null,
      balanceAfterCents: balanceAfter.netCents,
      creditBeforeCents: balanceBefore?.creditCents ?? null,
      creditAfterCents: balanceAfter.creditCents,
      outstandingBeforeCents: balanceBefore?.outstandingCents ?? null,
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
   * Tenant-first manual payment picker. Lists the chosen tenant's tenancies (and houses)
   * in the caller's estate scope, flagging which cover the payment day. Read-only; the
   * POST re-validates everything independently.
   */
  async tenantContext(clientId, estateFilter, { tenantId, paymentDate } = {}) {
    const tenant = await Tenant.findOne({
      _id: tenantId, clientId, ...estateFilterClause(estateFilter),
    }).lean();
    if (!tenant) throw Errors.TenantNotFound('Tenant not found in this estate');

    let nairobi = null;
    if (paymentDate) {
      nairobi = dateUtil.parseNairobiDateOnly(paymentDate);
      if (!nairobi) throw Errors.InvalidRequest('paymentDate must be a valid YYYY-MM-DD Nairobi calendar date');
    }

    const tenancies = await Tenancy.find({
      clientId, tenantId: tenant._id, estateId: tenant.estateId, status: { $in: ['ACTIVE', 'CLOSED'] },
    }).sort({ startAt: -1 }).lean();
    const houses = await House.find({
      _id: { $in: tenancies.map((t) => t.houseId) }, clientId, estateId: tenant.estateId,
    }).select('houseNumber status isActive').lean();
    const houseById = new Map(houses.map((h) => [String(h._id), h]));

    const rows = tenancies.map((t) => {
      const h = houseById.get(String(t.houseId));
      const start = new Date(t.startAt).getTime();
      const end = t.endAt == null ? null : new Date(t.endAt).getTime();
      const coversPaymentDate = nairobi
        ? start <= nairobi.end.getTime() && (end === null || end > nairobi.start.getTime())
        : null;
      return {
        tenancyId: String(t._id),
        houseId: String(t.houseId),
        houseNumber: h ? h.houseNumber : null,
        status: t.status,
        startAt: t.startAt,
        endAt: t.endAt || null,
        coversPaymentDate,
      };
    });

    const snap = await tenantAccountSnapshot({
      clientId, estateId: tenant.estateId, tenantId: tenant._id,
    });
    return {
      tenant: { _id: String(tenant._id), name: tenant.name, phone: tenant.phone, status: tenant.status },
      paymentDate: nairobi ? nairobi.dateStr : null,
      tenancies: rows,
      account: {
        creditCents: snap.creditCents,
        outstandingCents: snap.outstandingCents,
        netCents: snap.netCents,
      },
    };
  },

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
      tenantBalanceCents,
      creditCents,
      outstandingCents,
    };
  },
};
