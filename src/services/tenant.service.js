// src/services/tenant.service.js
import { Tenant } from '../models/Tenant.js';
import { House } from '../models/House.js';
import { Estate } from '../models/Estate.js';
import { RentCharge } from '../models/RentCharge.js';
import { SmsMessage } from '../models/SmsMessage.js';
import { AuditLog } from '../models/AuditLog.js';
import { Payment } from '../models/Payment.js';
import { ManualReceipt } from '../models/ManualReceipt.js';
import { Tenancy } from '../models/Tenancy.js';
import { TenantCreditMovement } from '../models/TenantCreditMovement.js';
import { Ledger } from '../models/Ledger.js';
import { creditBalanceCents } from './tenantCredit.service.js';
import { Errors } from '../utils/errors.js';
import { estateFilterClause } from '../utils/estateFilter.js';
import { dateUtil } from '../utils/date.js';
import { ledgerService } from './ledger.service.js';
import { tenancyService } from './tenancy.service.js';
import { smsService } from './sms.service.js';
import { formatRegistrationPlanText, formatSmsDisplayLabel } from './smsTemplates.js';
import { mpesaSubmissionLinkService } from './mpesa/mpesaSubmissionLink.service.js';
import { resolveRegistrationBillingPlan } from './rent.service.js';
import { logger } from '../config/logger.js';
import { generateBearerToken } from '../utils/g5Token.js';
import mongoose from 'mongoose';
import { supportsMongoTransactions } from '../config/database.js';

/**
 * Four distinct concepts (never interchangeable):
 *  A receivedCents        gross money received (ManualReceipt gross + non-child M-PESA/BANK/legacy
 *                         Payments + M-PESA surplus). Existing-credit applications are NOT received.
 *  B appliedToRentCents   amount allocated to this tenant's rent charges (from receipts AND credit).
 *  C creditCents          available credit = sum of immutable TenantCreditMovement rows.
 *  D outstandingCents     unpaid balance of this tenant's open charges.
 * Never derived by summing Payments for credit; ManualReceipt is never added to its own children.
 */
async function buildAccount(clientId, tenant, charges, tenancyIds) {
  const scope = { clientId, estateId: tenant.estateId, tenantId: tenant._id };
  const [receipts, otherPayments, movements, creditCents] = await Promise.all([
    ManualReceipt.find(scope).sort({ paymentDate: -1, _id: -1 }).lean(),
    Payment.find({
      ...scope, status: 'CONFIRMED',
      $or: [
        { origin: { $in: ['MPESA', 'BANK'] } },
        { origin: 'MANUAL', manualReceiptId: null },
        { origin: 'MANUAL', manualReceiptId: { $exists: false } },
      ],
    }).sort({ paymentDate: -1, _id: -1 }).lean(),
    TenantCreditMovement.find(scope).sort({ createdAt: -1, _id: -1 }).lean(),
    creditBalanceCents(scope),
  ]);

  const houseIds = [...new Set([
    ...receipts.map((r) => r.houseId), ...otherPayments.map((p) => p.houseId),
  ].filter(Boolean).map(String))];
  const houses = await House.find({ _id: { $in: houseIds }, clientId }).select('houseNumber').lean();
  const houseNo = new Map(houses.map((h) => [String(h._id), h.houseNumber]));

  const history = [];
  for (const r of receipts) {
    history.push({
      kind: 'manual_receipt',
      id: String(r._id),
      origin: 'MANUAL',
      status: r.status,
      paymentDate: r.paymentDate,
      paymentDateLocal: r.paymentDateLocal,
      reference: r.paymentReference || null,
      tenderMethod: r.tenderMethod,
      houseId: String(r.houseId),
      houseNumber: houseNo.get(String(r.houseId)) ?? null,
      tenancyId: String(r.occupancyTenancyId),
      grossCents: r.amountCents,
      appliedToRentCents: r.receiptAppliedCents || 0,
      appliedFromCreditCents: r.creditAppliedCents || 0,
      newCreditCents: r.newCreditCents || 0,
    });
  }
  for (const p of otherPayments) {
    history.push({
      kind: 'payment',
      id: String(p._id),
      origin: p.origin,
      status: p.status,
      paymentDate: p.paymentDate,
      paymentDateLocal: null,
      reference: p.paymentReference || null,
      tenderMethod: p.tenderMethod || null,
      houseId: p.houseId ? String(p.houseId) : null,
      houseNumber: houseNo.get(String(p.houseId)) ?? null,
      tenancyId: p.tenancyId ? String(p.tenancyId) : null,
      grossCents: p.amountCents,
      appliedToRentCents: p.amountCents,
      appliedFromCreditCents: 0,
      newCreditCents: 0,
    });
  }
  const mpesaSurplus = movements.filter(
    (m) => m.movementType === 'RECEIPT_SURPLUS' && !m.manualReceiptId
  );
  for (const m of mpesaSurplus) {
    history.push({
      kind: 'mpesa_surplus', id: String(m._id), origin: 'MPESA', status: 'CONFIRMED',
      paymentDate: m.createdAt, paymentDateLocal: null, reference: null, tenderMethod: 'MPESA',
      houseId: null, houseNumber: null, tenancyId: m.tenancyId ? String(m.tenancyId) : null,
      grossCents: m.amountCents, appliedToRentCents: 0, appliedFromCreditCents: 0,
      newCreditCents: m.amountCents,
    });
  }
  history.sort((a, b) => new Date(b.paymentDate) - new Date(a.paymentDate));

  const sum = (arr, f) => arr.reduce((t, x) => t + (f(x) || 0), 0);
  const receivedCents = sum(history, (h) => h.grossCents);
  const own = charges.filter((c) => tenancyIds.some((id) => String(id) === String(c.tenancyId)) || String(c.tenantId) === String(tenant._id));
  const billedCents = sum(own, (c) => c.amountDueCents);
  const appliedToRentCents = sum(own, (c) => c.amountPaidCents);
  const outstandingCents = sum(own, (c) => Math.max(c.balanceCents || 0, 0));
  const appliedFromCreditCents = -sum(movements.filter((m) => m.movementType === 'CREDIT_APPLIED'), (m) => m.amountCents);

  return {
    paymentHistory: history,
    account: {
      receivedCents,
      billedCents,
      appliedToRentCents,
      appliedFromCreditCents,
      creditCents,
      outstandingCents,
      netCents: creditCents - outstandingCents,
    },
  };
}

export const tenantService = {
  async create(clientId, data, actorUserId = null) {
    if (supportsMongoTransactions() === false) {
      throw Errors.ServiceUnavailable('MongoDB transactions required for tenant create');
    }
    const tenantId = new mongoose.Types.ObjectId();
    const registrationLinkId = new mongoose.Types.ObjectId();
    const registrationMessageId = new mongoose.Types.ObjectId();
    const registrationToken = generateBearerToken();
    // Capture once before the retryable transaction; reuse on callback retries.
    // Do not substitute moveInDate.
    const registrationAt = new Date();
    const session = await mongoose.startSession();
    try {
      let tenant;
      await session.withTransaction(async () => {
        const house = await House.findOne({ _id: data.houseId, clientId }).session(session);
        if (!house || house.isActive === false) throw Errors.HouseNotFound();
        const estate = await Estate.findOne({ _id: house.estateId, clientId }).session(session).lean();
        if (!estate?.name) throw Errors.Conflict('House Estate ownership could not be verified');
        const [created] = await Tenant.create(
          [{ ...data, phone: typeof data.phone === 'string' && data.phone.trim() ? data.phone.trim() : null, _id: tenantId, clientId, estateId: house.estateId, status: 'active' }],
          { session }
        );
        tenant = created;
        const tenancy = await tenancyService.open({
          clientId, estateId: house.estateId, houseId: house._id,
          tenantId: tenant._id, startAt: data.moveInDate || new Date(), actorUserId,
        }, { session });

        // Registration SMS describes the House configured billing plan at registrationAt.
        // Never generate RentCharges or claim Paid/Outstanding/invoice status.
        let billText;
        try {
          const snapshot = await resolveRegistrationBillingPlan(house, registrationAt, { session });
          billText = formatRegistrationPlanText(snapshot, estate.currency || 'KES');
        } catch (err) {
          logger.warn(
            { tenantId: String(tenant._id), estateId: String(house.estateId), code: err.code || 'BILLING_SNAPSHOT_INVALID' },
            'Registration billing snapshot omitted because plan resolution failed'
          );
          billText = 'The configured billing plan could not be verified at registration.';
        }
        const registrationText = `Registration confirmed for ${formatSmsDisplayLabel(tenant.name)}, House ${house.houseNumber}. ${billText}`;
        const provision = await mpesaSubmissionLinkService.provisionForRegistration({
          clientId, estateId: house.estateId, tenant, house, estate,
          registrationText, session, linkId: registrationLinkId,
          messageId: registrationMessageId, token: registrationToken, actorUserId,
        });

        if (!provision.eligible) {
          logger.info(
            { tenantId: String(tenant._id), estateId: String(house.estateId), reason: provision.reason || 'unknown' },
            'M-PESA registration link not provisioned; using ordinary registration SMS'
          );
          if (tenant.phone) {
            const ordinaryRegistrationText = `${registrationText}\n\nFor verified bank payment instructions, contact the estate office.`;
            await smsService.queueSms({
              clientId, estateId: house.estateId, tenantId: tenant._id, houseId: house._id,
              to: tenant.phone, message: ordinaryRegistrationText,
              type: 'tenant_registration', priority: 8, period: dateUtil.periodOf(registrationAt),
              notificationVersion: 'tenant_registration:v1',
              idempotencyKey: `registration:${String(tenant._id)}:v1`,
              session,
            });
          } else {
            await AuditLog.create([{
              clientId, estateId: house.estateId, userId: actorUserId || undefined,
              action: 'TENANT_REGISTRATION_SMS_BLOCKED',
              resource: 'Tenant', resourceId: String(tenant._id),
              description: 'Registration SMS could not be queued because the tenant phone number is missing',
              metadata: { reason: 'tenant_phone_missing' },
            }], { session });
            logger.warn({ tenantId: String(tenant._id), estateId: String(house.estateId), reason: 'tenant_phone_missing' }, 'Tenant registration SMS was not queued because the tenant has no phone number');
          }
        }
      });
      return tenant;
    } finally {
      await session.endSession();
    }
  },

  list: (clientId, estateFilter) =>
    Tenant.find({ clientId, ...estateFilterClause(estateFilter) }).sort({ createdAt: -1 }),

  async get(clientId, tenantId, estateFilter = null) {
    const tenant = await Tenant.findOne({
      _id: tenantId,
      clientId,
      ...estateFilterClause(estateFilter),
    }).lean();
    if (!tenant) throw Errors.TenantNotFound();

    const ownTenancies = await Tenancy.find({
      clientId,
      tenantId: tenant._id,
      estateId: tenant.estateId,
      status: { $in: ['ACTIVE', 'CLOSED'] },
    }).select('_id houseId').lean();
    const tenancyIds = ownTenancies.map((tenancy) => tenancy._id);

    const [house, estate, charges, sms, activity, payments] = await Promise.all([
      House.findOne({ _id: tenant.houseId, clientId }).lean(),
      Estate.findOne({ _id: tenant.estateId, clientId }).lean(),
      RentCharge.find({
        clientId,
        estateId: tenant.estateId,
        $or: [
          { tenantId: tenant._id },
          { tenancyId: { $in: tenancyIds } },
        ],
      })
        .sort({ period: -1 })
        .lean(),
      SmsMessage.find({ clientId, tenantId: tenant._id }).sort({ createdAt: -1 }).limit(20).lean(),
      AuditLog.find({
        clientId,
        resource: 'Tenant',
        resourceId: tenant._id,
      })
        .sort({ createdAt: -1 })
        .limit(20)
        .lean(),
      Payment.find({ clientId, tenantId: tenant._id, status: 'CONFIRMED' })
        .sort({ paymentDate: -1 })
        .limit(50)
        .lean(),
    ]);

    let billedCents = 0;
    let paidFromChargesCents = 0;
    const byPeriod = new Map();

    for (const c of charges) {
      billedCents += c.amountDueCents || 0;
      paidFromChargesCents += c.amountPaidCents || 0;
      const key = c.period || 'unknown';
      const row = byPeriod.get(key) || {
        period: key,
        billedCents: 0,
        paidCents: 0,
        outstandingCents: 0,
      };
      row.billedCents += c.amountDueCents || 0;
      row.paidCents += c.amountPaidCents || 0;
      row.outstandingCents += Math.max(c.balanceCents || 0, 0);
      byPeriod.set(key, row);
    }

    const monthly = [...byPeriod.values()].sort((a, b) => (a.period < b.period ? 1 : -1));

    const tenancyBalances = await Promise.all(
      ownTenancies.map(async (tenancy) => {
        const [balance, hasRentLedger] = await Promise.all([
          ledgerService.balanceForTenancy(clientId, tenancy._id),
          Ledger.exists({
            clientId,
            estateId: tenant.estateId,
            tenancyId: tenancy._id,
            accountCategory: 'RENT',
          }),
        ]);
        return hasRentLedger ? balance : null;
      })
    );
    const availableTenancyBalances = tenancyBalances.filter(
      (balance) => balance && Number.isSafeInteger(balance.knownArrearsCents)
    );
    const knownArrearsCents = availableTenancyBalances.length
      ? availableTenancyBalances.reduce((total, balance) => total + balance.knownArrearsCents, 0)
      : null;
    const ledgerCoverage = availableTenancyBalances[0] || null;
    const paidCents = paidFromChargesCents;
    const account = await buildAccount(clientId, tenant, charges, tenancyIds);

    return {
      ...tenant,
      house: house
        ? {
            _id: house._id,
            houseNumber: house.houseNumber,
            status: house.status,
            houseTypeId: house.houseTypeId,
          }
        : null,
      estate: estate ? { _id: estate._id, name: estate.name, address: estate.address } : null,
      financials: {
        billedCents,
        paidCents,
        outstandingCents: account.account.outstandingCents,
        knownArrearsCents,
        historicalCoverage: ledgerCoverage?.historicalCoverage ?? 'UNVERIFIED',
        verifiedFullObligation: ownTenancies.length > 0
          && availableTenancyBalances.length === ownTenancies.length
          && availableTenancyBalances.every((balance) => balance.verifiedFullObligation === true),
        balanceSource: availableTenancyBalances.length ? 'ledger_tenancy_sum' : 'unavailable',
        overdueCents: charges
          .filter((c) => Math.max(c.balanceCents || 0, 0) > 0 && c.dueDate && new Date(c.dueDate) < new Date())
          .reduce((s, c) => s + Math.max(c.balanceCents || 0, 0), 0),
        oldestUnpaidPeriod: (() => {
          const open = charges
            .filter((c) => Math.max(c.balanceCents || 0, 0) > 0)
            .map((c) => c.period)
            .sort();
          return open[0] || null;
        })(),
        currentPeriod: dateUtil.currentPeriod(),
      },
      account: account.account,
      paymentHistory: account.paymentHistory,
      payments: payments.map((p) => ({
        _id: p._id,
        amountCents: p.amountCents,
        paymentDate: p.paymentDate,
        paymentReference: p.paymentReference,
        period: p.period,
        houseId: p.houseId,
        status: p.status,
      })),
      monthly,
      billingHistory: charges.slice(0, 50).map((c) => ({
        _id: c._id,
        period: c.period,
        chargeType: c.chargeType,
        amountDueCents: c.amountDueCents,
        amountPaidCents: c.amountPaidCents,
        balanceCents: c.balanceCents,
        status: c.status,
      })),
      smsHistory: sms.map((m) => ({
        _id: m._id,
        phoneNumber: m.phoneNumber,
        message: m.deliveryMode === 'G5_PROTECTED'
          ? 'M-PESA onboarding notification (private payment link hidden for security).'
          : m.message,
        status: m.status,
        type: m.type,
        deliveryMode: m.deliveryMode || 'STANDARD',
        createdAt: m.createdAt,
        sentAt: m.sentAt,
      })),
      activity,
    };
  },

  async update(clientId, tenantId, updates, estateFilter = null, actorUserId = null) {
    const tenant = await Tenant.findOneAndUpdate(
      { _id: tenantId, clientId, ...estateFilterClause(estateFilter) },
      updates,
      { new: true }
    );
    if (!tenant) throw Errors.TenantNotFound();

    if (updates.status === 'moved_out') {
      const active = await tenancyService.getActiveForHouse(clientId, tenant.houseId);
      if (active && String(active.tenantId) === String(tenant._id)) {
        await tenancyService.close(clientId, active._id, { reason: 'MOVE_OUT', actorUserId });
      } else {
        await House.updateOne(
          { _id: tenant.houseId, clientId, ...estateFilterClause(estateFilter) },
          { tenantId: null, status: 'vacant' }
        );
      }
    }
    return tenant;
  },

  async moveToHouse(clientId, tenantId, newHouseId, estateFilter = null, actorUserId = null) {
    await tenancyService.moveToHouse(clientId, tenantId, newHouseId, estateFilter, actorUserId);
    const tenant = await Tenant.findOne({ _id: tenantId, clientId });
    if (!tenant) throw Errors.TenantNotFound();
    return tenant;
  },
};
