// src/services/tenant.service.js
import { Tenant } from '../models/Tenant.js';
import { House } from '../models/House.js';
import { Estate } from '../models/Estate.js';
import { RentCharge } from '../models/RentCharge.js';
import { SmsMessage } from '../models/SmsMessage.js';
import { AuditLog } from '../models/AuditLog.js';
import { Payment } from '../models/Payment.js';
import { Errors } from '../utils/errors.js';
import { estateFilterClause } from '../utils/estateFilter.js';
import { dateUtil } from '../utils/date.js';
import { ledgerService } from './ledger.service.js';
import { tenancyService } from './tenancy.service.js';
import { smsService } from './sms.service.js';
import { mpesaSubmissionLinkService } from './mpesa/mpesaSubmissionLink.service.js';
import { aggregateRentCharges } from '../utils/smsBilling.js';
import { logger } from '../config/logger.js';
import { money } from '../utils/money.js';
import { generateBearerToken } from '../utils/g5Token.js';
import mongoose from 'mongoose';
import { supportsMongoTransactions } from '../config/database.js';


export const tenantService = {
  async create(clientId, data, actorUserId = null) {
    if (supportsMongoTransactions() === false) {
      throw Errors.ServiceUnavailable('MongoDB transactions required for tenant create');
    }
    const tenantId = new mongoose.Types.ObjectId();
    const registrationLinkId = new mongoose.Types.ObjectId();
    const registrationMessageId = new mongoose.Types.ObjectId();
    const registrationToken = generateBearerToken();
    const session = await mongoose.startSession();
    try {
      let tenant;
      await session.withTransaction(async () => {
        // House/Estate ownership is checked inside the same transaction as occupancy.
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

        // Registration statements are informational snapshots only. Never generate
        // financial charges here or alter the G3 billing/partial-period policy.
        const period = dateUtil.currentPeriod();
        const currentCharges = await RentCharge.find({
          clientId, estateId: house.estateId, tenancyId: tenancy._id, period,
        }).session(session).lean();
        let billText = 'Current billing details are not available yet.';
        if (currentCharges.length) {
          try {
            const totals = aggregateRentCharges(currentCharges);
            billText = [
              `Current bill ${period}:`,
              `Rent ${money.format(totals.rentCents, estate.currency || 'KES')}`,
              `Water ${money.format(totals.waterCents, estate.currency || 'KES')}`,
              `Electricity ${money.format(totals.electricityCents, estate.currency || 'KES')}`,
              `Other ${money.format(totals.otherCents, estate.currency || 'KES')}`,
              `Paid ${money.format(totals.paidCents, estate.currency || 'KES')}`,
              `Outstanding ${money.format(totals.totalOutstandingCents, estate.currency || 'KES')}`,
              totals.dueDates.length ? `Due ${totals.dueDates.map((d) => dateUtil.format(d, 'DD MMM YYYY')).join(', ')}` : null,
            ].filter(Boolean).join('. ') + '.';
          } catch (err) {
            logger.warn({ tenantId: String(tenant._id), estateId: String(house.estateId), code: err.code || 'BILLING_SNAPSHOT_INVALID' }, 'Registration billing snapshot omitted because source data was invalid');
            billText = 'Current billing details are temporarily unavailable.';
          }
        }
        const registrationText = `Registration confirmed for ${tenant.name}, House ${house.houseNumber}. ${billText}`;
        const provision = await mpesaSubmissionLinkService.provisionForRegistration({
          clientId, estateId: house.estateId, tenant, house, estate,
          registrationText, session, linkId: registrationLinkId,
          messageId: registrationMessageId, token: registrationToken, actorUserId,
        });

        // Exactly one welcome path: protected M-PESA onboarding OR ordinary SMS.
        // No phone means no outbox row, but a valid tenant/tenancy still commits.
        if (!provision.eligible) {
          if (tenant.phone) {
            // BankAccount is a statement-ingestion connection, not an authoritative
            // rent-receiving destination. Do not expose it as payment instructions.
            const ordinaryRegistrationText = registrationText + ' For verified bank payment instructions, contact the estate office.';
            await smsService.queueSms({
              clientId, estateId: house.estateId, tenantId: tenant._id, houseId: house._id,
              to: tenant.phone, message: ordinaryRegistrationText,
              type: 'tenant_registration', priority: 8, period,
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

    const [house, estate, charges, sms, activity, payments] = await Promise.all([
      House.findOne({ _id: tenant.houseId, clientId }).lean(),
      Estate.findOne({ _id: tenant.estateId, clientId }).lean(),
      RentCharge.find({
        clientId,
        $or: [
          { tenantId: tenant._id },
          ...(tenant.houseId ? [{ houseId: tenant.houseId }] : []),
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

    // Billing metrics from RentCharge; account balance from Ledger (source of truth)
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

    const activeTenancy = await tenancyService.getActiveForHouse(clientId, tenant.houseId);
    const ledgerBal = activeTenancy
      ? await ledgerService.balanceForTenancy(clientId, activeTenancy._id)
      : tenant.houseId
        ? await ledgerService.balanceForHouse(clientId, tenant.houseId)
        : await ledgerService.balanceForTenant(clientId, tenant._id, null);
    // Authoritative outstanding = Ledger running balance (amount owed)
    const knownArrearsCents = Number.isSafeInteger(ledgerBal?.knownArrearsCents)
      ? ledgerBal.knownArrearsCents
      : null;
    const outstandingCents = knownArrearsCents;
    // Prefer ledger-reported payments when available; fall back to charge cache
    const paidFromLedger = tenant.houseId
      ? await ledgerService.totalPaymentsReceived(clientId, { houseId: tenant.houseId })
      : await ledgerService.totalPaymentsReceived(clientId, { tenantId: tenant._id });
    const paidCents = paidFromLedger > 0 ? paidFromLedger : paidFromChargesCents;

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
        outstandingCents,
        knownArrearsCents,
        historicalCoverage: ledgerBal?.historicalCoverage ?? 'UNVERIFIED',
        verifiedFullObligation: ledgerBal?.verifiedFullObligation === true,
        balanceSource: ledgerBal?.source || 'unavailable',
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
        message: m.message,
        status: m.status,
        type: m.type,
        createdAt: m.createdAt,
        sentAt: m.sentAt,
      })),
      activity,
    };
  },

  async update(clientId, tenantId, updates, estateFilter = null) {
    const tenant = await Tenant.findOneAndUpdate(
      { _id: tenantId, clientId, ...estateFilterClause(estateFilter) },
      updates,
      { new: true }
    );
    if (!tenant) throw Errors.TenantNotFound();

    if (updates.status === 'moved_out') {
      const active = await tenancyService.getActiveForHouse(clientId, tenant.houseId);
      if (active && String(active.tenantId) === String(tenant._id)) {
        await tenancyService.close(clientId, active._id, { reason: 'MOVE_OUT' });
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
