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

export const tenantService = {
  async create(clientId, data) {
    const house = await House.findOne({ _id: data.houseId, clientId });
    if (!house) throw Errors.HouseNotFound();

    const tenant = await Tenant.create({ ...data, clientId, estateId: house.estateId });
    house.tenantId = tenant._id;
    house.status = 'occupied';
    await house.save();
    return tenant;
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

    const ledgerBal = tenant.houseId
      ? await ledgerService.balanceForHouse(clientId, tenant.houseId)
      : await ledgerService.balanceForTenant(clientId, tenant._id, null);
    // Authoritative outstanding = Ledger running balance (amount owed)
    const outstandingCents = Math.max(ledgerBal.balanceCents || 0, 0);
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
        balanceSource: ledgerBal.source,
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
      await House.updateOne(
        { _id: tenant.houseId, clientId, ...estateFilterClause(estateFilter) },
        { tenantId: null, status: 'vacant' }
      );
    }
    return tenant;
  },

  async moveToHouse(clientId, tenantId, newHouseId, estateFilter = null) {
    const tenant = await Tenant.findOne({
      _id: tenantId,
      clientId,
      ...estateFilterClause(estateFilter),
    });
    if (!tenant) throw Errors.TenantNotFound();

    const newHouse = await House.findOne({
      _id: newHouseId,
      clientId,
      isActive: true,
      ...estateFilterClause(estateFilter),
    });
    if (!newHouse) throw Errors.HouseNotFound('Target house not found for your client');
    if (newHouse.tenantId && !newHouse.tenantId.equals(tenant._id)) {
      throw Errors.Conflict('Target house already has a tenant');
    }

    const oldHouseId = tenant.houseId;

    if (oldHouseId && !oldHouseId.equals(newHouse._id)) {
      await House.updateOne(
        { _id: oldHouseId, clientId, ...estateFilterClause(estateFilter) },
        { tenantId: null, status: 'vacant' }
      );
    }

    tenant.houseId = newHouse._id;
    tenant.estateId = newHouse.estateId;
    await tenant.save();

    newHouse.tenantId = tenant._id;
    newHouse.status = 'occupied';
    await newHouse.save();

    return tenant;
  },
};
