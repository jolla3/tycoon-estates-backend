// src/services/sms.service.js
//
// SMS is provider-agnostic (Celcom adapter via factory). Message content is
// templated here. Every job is clientId-scoped. Broadcasts create one
// SmsMessage per recipient.

import crypto from 'crypto';
import { SmsMessage, NOTIFICATION_VERSIONS } from '../models/SmsMessage.js';
import { Tenant } from '../models/Tenant.js';
import { House } from '../models/House.js';
import { Estate } from '../models/Estate.js';
import { ledgerService } from './ledger.service.js';
import { tenancyService } from './tenancy.service.js';
import { RentCharge } from '../models/RentCharge.js';
import { Tenancy } from '../models/Tenancy.js';
import { aggregateRentCharges, sumOutstandingCents } from '../utils/smsBilling.js';
import { getSmsProvider } from './sms/sms.factory.js';
import { withIdempotency } from '../utils/idempotency.js';
import { money } from '../utils/money.js';
import { dateUtil } from '../utils/date.js';
import { Errors } from '../utils/errors.js';
import { logger } from '../config/logger.js';
import { estateFilterClause } from '../utils/estateFilter.js';
import { audit } from './audit.service.js';

const TEMPLATES = {
  rent_reminder: ({ tenantName, houseNumber, balanceCents, currency }) =>
    'Dear ' + tenantName + ', House ' + houseNumber + ' has an outstanding rent balance of ' +
      money.format(balanceCents, currency) + '. Kindly settle it at your earliest convenience.',
  rent_reminder_d5: ({
    tenantName, houseNumber, period, dueDate,
    rentOutstandingCents, waterOutstandingCents,
    electricityOutstandingCents, otherOutstandingCents,
    previousArrearsCents, totalOutstandingCents, currency = 'KES',
  }) => {
    for (const [field, value] of Object.entries({
      rentOutstandingCents, waterOutstandingCents,
      electricityOutstandingCents, otherOutstandingCents,
      previousArrearsCents, totalOutstandingCents,
    })) {
      requireTemplateCents(value, field);
    }
    for (const [field, value] of Object.entries({ tenantName, houseNumber, period, dueDate })) {
      if (typeof value !== 'string' || !value.trim()) {
        throw Errors.InvalidRequest('Cannot render D-5 reminder without ' + field);
      }
    }
    return [
      'Rent due in five days on ' + dueDate + ' for ' + tenantName +
        ', House ' + houseNumber + ' (' + period + ').',
      rentOutstandingCents ? 'Rent outstanding: ' + money.format(rentOutstandingCents, currency) + '.' : null,
      waterOutstandingCents ? 'Water outstanding: ' + money.format(waterOutstandingCents, currency) + '.' : null,
      electricityOutstandingCents ? 'Electricity outstanding: ' + money.format(electricityOutstandingCents, currency) + '.' : null,
      otherOutstandingCents ? 'Other outstanding: ' + money.format(otherOutstandingCents, currency) + '.' : null,
      previousArrearsCents ? 'Previous arrears: ' + money.format(previousArrearsCents, currency) + '.' : null,
      'Total outstanding: ' + money.format(totalOutstandingCents, currency) + '.',
    ].filter(Boolean).join(' ');
  },
  payment_confirmation: ({ tenantName, houseNumber, amountCents, balanceCents, currency }) =>
    `Dear ${tenantName}, we have received your payment of ${money.format(amountCents, currency)} for House ${houseNumber}. Remaining balance: ${money.format(Math.max(balanceCents, 0), currency)}. Thank you.`,
  arrears_notice: ({ tenantName, houseNumber, monthsOverdue, balanceCents, currency }) =>
    `Dear ${tenantName}, House ${houseNumber} is ${monthsOverdue} month(s) in arrears, totaling ${money.format(balanceCents, currency)}. Please contact the estate office urgently.`,
  billing_notification: ({
    tenantName, houseNumber, period,
    rentOutstandingCents, waterOutstandingCents,
    electricityOutstandingCents, otherOutstandingCents,
    previousArrearsCents, paidCents, totalOutstandingCents,
    dueDate, currency = 'KES',
  }) => {
    for (const [field, value] of Object.entries({
      rentOutstandingCents, waterOutstandingCents,
      electricityOutstandingCents, otherOutstandingCents,
      previousArrearsCents, paidCents, totalOutstandingCents,
    })) {
      requireTemplateCents(value, field);
    }
    const lines = [
      'Billing statement ' + period + ' for ' + tenantName + ', House' +
        (String(houseNumber).includes(',') ? 's' : '') + ' ' + houseNumber + '.',
      rentOutstandingCents ? 'Rent outstanding: ' + money.format(rentOutstandingCents, currency) + '.' : null,
      waterOutstandingCents ? 'Water outstanding: ' + money.format(waterOutstandingCents, currency) + '.' : null,
      electricityOutstandingCents ? 'Electricity outstanding: ' + money.format(electricityOutstandingCents, currency) + '.' : null,
      otherOutstandingCents ? 'Other outstanding: ' + money.format(otherOutstandingCents, currency) + '.' : null,
      previousArrearsCents ? 'Previous arrears: ' + money.format(previousArrearsCents, currency) + '.' : null,
      paidCents ? 'Paid this period: ' + money.format(paidCents, currency) + '.' : null,
      'Total outstanding: ' + money.format(totalOutstandingCents, currency) + '.',
      dueDate ? 'Due: ' + dueDate + '.' : null,
    ].filter(Boolean);
    return lines.join(' ');
  },
};


function requireTemplateCents(value, field) {
  if (!Number.isSafeInteger(value) || value < 0) {
    const err = Errors.InvalidRequest('Cannot render billing SMS: ' + field + ' must be a verified non-negative integer-cent value');
    err.code = 'SMS_TEMPLATE_AMOUNT_INVALID';
    throw err;
  }
  return value;
}

function prefixEstate(estateName, message) {
  const name = String(estateName || '').trim();
  const body = String(message || '').trim();
  if (!name || !body) {
    throw Errors.InvalidRequest('Estate name and SMS body are required');
  }
  const prefix = name + ':';
  return body.startsWith(prefix) ? body : prefix + ' ' + body;
}

export function previewSms(type, templateData) {
  const render = TEMPLATES[type];
  if (!render) throw Errors.InvalidRequest(`Unknown SMS template: ${type}`);
  return render({ currency: 'KES', ...templateData });
}

function buildIdempotencyKey({
  clientId,
  tenantId,
  to,
  period,
  type,
  notificationVersion,
  forceResend,
  broadcastId,
}) {
  if (forceResend) {
    return `sms_force_${clientId}_${tenantId || 'na'}_${type}_${crypto.randomBytes(8).toString('hex')}`;
  }
  // Explicit logical identity: client + tenant + period + type + version
  const raw = [
    String(clientId),
    String(tenantId || 'na'),
    String(to || '').trim().replace(/\s+/g, ''),
    String(period || 'none'),
    String(type),
    String(notificationVersion || NOTIFICATION_VERSIONS[type] || type),
    broadcastId ? String(broadcastId) : '',
  ].join('|');
  return crypto.createHash('sha256').update(raw).digest('hex').slice(0, 48);
}

function maskPhone(phone) {
  if (!phone || phone.length < 4) return '****';
  return `${phone.slice(0, 3)}****${phone.slice(-2)}`;
}

export const smsService = {
  async queueSms({
    clientId,
    estateId,
    tenantId,
    houseId,
    to,
    message,
    type = 'general',
    priority = 0,
    period = null,
    notificationVersion = null,
    broadcastId = null,
    forceResend = false,
    idempotencyKey: providedKey,
    session = null,
  }) {
    if (!clientId) throw Errors.InvalidRequest('clientId is required');
    if (!estateId) throw Errors.InvalidRequest('estateId is required for SMS');
    if (!to || !message) throw Errors.InvalidRequest('Phone number and message are required');

    const estateQuery = Estate.findOne({ _id: estateId, clientId }).select('name');
    if (session) estateQuery.session(session);
    const estate = await estateQuery.lean();
    if (!estate?.name) {
      logger.error(
        { clientId: String(clientId), estateId: String(estateId), tenantId: tenantId ? String(tenantId) : null, type, reason: 'estate_identity_unavailable' },
        'SMS was not queued because estate ownership/name could not be verified'
      );
      throw Errors.InvalidRequest('SMS estate ownership/name could not be verified');
    }
    const body = prefixEstate(estate.name, message);

    const version =
      notificationVersion || NOTIFICATION_VERSIONS[type] || null;

    const idempotencyKey =
      providedKey ||
      buildIdempotencyKey({
        clientId,
        tenantId,
        to,
        period,
        type,
        notificationVersion: version,
        forceResend,
        broadcastId,
      });

    const payload = {
      clientId,
      estateId,
      tenantId,
      houseId,
      phoneNumber: to,
      message: body,
      type,
      priority,
      period,
      notificationVersion: version,
      broadcastId,
      idempotencyKey,
    };

    if (session) {
      const existing = await SmsMessage.findOne({ clientId, idempotencyKey }).session(session);
      if (existing) return { doc: existing, created: false };
      const [doc] = await SmsMessage.create([payload], { session });
      return { doc, created: true };
    }

    return withIdempotency(
      SmsMessage,
      idempotencyKey,
      'idempotencyKey',
      () => SmsMessage.create(payload)
    );
  },

  /**
   * Individual SMS: resolve recipient from tenant (preferred) or house under
   * authenticated client + estateFilter. Never trust a client-supplied estateId.
   */
  async sendIndividual(clientId, { tenantId, houseId, message, forceResend = false }, estateFilter = null) {
    if (!message || !String(message).trim()) throw Errors.InvalidRequest('Message is required');
    if (!tenantId && !houseId) throw Errors.InvalidRequest('Select a tenant (or house) to send SMS');

    let tenant = null;
    let house = null;

    if (tenantId) {
      tenant = await Tenant.findOne({
        _id: tenantId,
        clientId,
        status: 'active',
        ...estateFilterClause(estateFilter),
      });
      if (!tenant) throw Errors.TenantNotFound();
      house = tenant.houseId
        ? await House.findOne({ _id: tenant.houseId, clientId, ...estateFilterClause(estateFilter) })
        : null;
    } else if (houseId) {
      house = await House.findOne({
        _id: houseId,
        clientId,
        ...estateFilterClause(estateFilter),
      });
      if (!house) throw Errors.HouseNotFound();
      if (house.tenantId) {
        tenant = await Tenant.findOne({
          _id: house.tenantId,
          clientId,
          status: 'active',
          ...estateFilterClause(estateFilter),
        });
      }
    }

    const phone = tenant?.phone;
    if (!phone) throw Errors.InvalidRequest('Selected tenant has no phone number on file');

    // Resolve estate server-side only. Legacy tenants may lack estateId —
    // fall back to house, then re-load house from tenant.houseId if needed.
    let estateId = tenant?.estateId || house?.estateId || null;
    if (!estateId && tenant?.houseId && !house) {
      house = await House.findOne({
        _id: tenant.houseId,
        clientId,
        ...estateFilterClause(estateFilter),
      });
      estateId = house?.estateId || null;
    }
    if (!estateId) {
      throw Errors.InvalidRequest('Could not resolve estate for the selected recipient');
    }

    return this.queueSms({
      clientId,
      estateId,
      tenantId: tenant?._id || null,
      houseId: house?._id || tenant?.houseId || null,
      to: phone,
      message: String(message).trim(),
      type: 'general',
      forceResend: Boolean(forceResend),
    });
  },

  sendTemplated(type, args) {
    const render = TEMPLATES[type];
    if (!render) throw Errors.InvalidRequest(`Unknown SMS template: ${type}`);
    const {
      clientId,
      estateId,
      tenantId,
      houseId,
      phone,
      priority = 0,
      period,
      forceResend = false,
      idempotencyKey,
      notificationVersion,
      ...templateData
    } = args;
    const message = render({ currency: args.currency || 'KES', period, ...templateData });
    return this.queueSms({
      clientId,
      estateId,
      tenantId,
      houseId,
      to: phone,
      message,
      type,
      priority,
      period: period || null,
      forceResend,
      idempotencyKey,
      notificationVersion,
    });
  },

  sendRentReminder: (args) =>
    smsService.sendTemplated('rent_reminder', { ...args, priority: 8, currency: args.currency || 'KES' }),
  sendPaymentConfirmation: (args) =>
    smsService.sendTemplated('payment_confirmation', {
      ...args,
      priority: 5,
      currency: args.currency || 'KES',
    }),
  sendArrearsNotice: (args) =>
    smsService.sendTemplated('arrears_notice', { ...args, priority: 10, currency: args.currency || 'KES' }),

  previewBillingNotification(templateData) {
    return previewSms('billing_notification', templateData);
  },

  /**
   * Preview without sending. Loads tenant/house balances from financial SoT when ids provided.
   * estateFilter (from clientContext) is enforced so restricted STAFF cannot load
   * another estate's tenant/house data by guessing Mongo IDs.
   */
  async preview(clientId, { template = 'billing_notification', tenantId, houseId, period, estateFilter = null, ...vars }) {
    const p = period || dateUtil.currentPeriod();
    if (template === 'billing_notification') {
      let tenant = null;
      let house = null;
      if (tenantId) {
        tenant = await Tenant.findOne({
          _id: tenantId, clientId, status: 'active',
          ...estateFilterClause(estateFilter),
        }).lean();
        if (!tenant) throw Errors.TenantNotFound();
        houseId = houseId || tenant.houseId;
      }
      if (houseId) {
        house = await House.findOne({
          _id: houseId, clientId, ...estateFilterClause(estateFilter),
        }).select('_id estateId houseNumber tenantId').lean();
        if (!house) throw Errors.HouseNotFound();
        if (tenant && String(tenant.estateId) !== String(house.estateId)) {
          throw Errors.Conflict('Billing preview tenant and house belong to different estates');
        }
        if (tenant && house.tenantId && String(house.tenantId) !== String(tenant._id)) {
          throw Errors.Conflict('Billing preview house is occupied by a different tenant');
        }
        if (!tenant && house.tenantId) {
          tenant = await Tenant.findOne({
            _id: house.tenantId, clientId, status: 'active',
            ...estateFilterClause(estateFilter),
          }).lean();
        }
      }
      const estateId = tenant ? tenant.estateId : house?.estateId;
      if (!estateId) throw Errors.InvalidRequest('Estate could not be resolved for billing preview');
      const estate = await Estate.findOne({ _id: estateId, clientId }).select('name currency').lean();
      if (!estate?.name) throw Errors.InvalidRequest('Estate identity could not be verified for billing preview');

      let tenancyIds = [];
      if (tenant?._id) {
        tenancyIds = (await Tenancy.find({
          clientId, estateId, tenantId: tenant._id,
          status: { $in: ['ACTIVE', 'CLOSED'] },
        }).select('_id').lean()).map((row) => row._id);
      }
      const currentFilter = { clientId, estateId, period: p };
      if (tenancyIds.length && tenant?._id) {
        currentFilter.$or = [
          { tenancyId: { $in: tenancyIds } },
          { tenantId: tenant._id },
        ];
      } else if (tenant?._id) {
        currentFilter.tenantId = tenant._id;
      } else if (house?._id) {
        currentFilter.houseId = house._id;
      } else {
        throw Errors.InvalidRequest('Tenant tenancy history is unavailable for billing preview');
      }

      const charges = await RentCharge.find(currentFilter).lean();
      const current = aggregateRentCharges(charges);
      const previousFilter = {
        clientId, estateId, period: { $lt: p },
        status: { $in: ['UNPAID', 'PARTIAL'] },
      };
      if (tenancyIds.length && tenant?._id) {
        previousFilter.$or = [
          { tenancyId: { $in: tenancyIds } },
          { tenantId: tenant._id },
        ];
      } else if (tenant?._id) {
        previousFilter.tenantId = tenant._id;
      } else {
        previousFilter.houseId = house._id;
      }
      const previous = await RentCharge.find(previousFilter).lean();
      const previousArrearsCents = sumOutstandingCents(previous);
      const totalOutstandingCents = current.totalOutstandingCents + previousArrearsCents;
      requireTemplateCents(totalOutstandingCents, 'totalOutstandingCents');

      const billedHouseIds = [...new Set(charges.map((row) => String(row.houseId)).filter(Boolean))];
      const houses = billedHouseIds.length
        ? await House.find({ clientId, estateId, _id: { $in: billedHouseIds } }).select('_id houseNumber').lean()
        : [];
      const houseNumbers = houses.map((row) => row.houseNumber).filter(Boolean);
      const dueDate = current.dueDates.map((date) => dateUtil.format(date, 'DD MMM YYYY')).join(', ') || null;
      const variables = {
        tenantName: tenant?.name || vars.tenantName || 'Tenant',
        houseNumber: houseNumbers.join(', ') || house?.houseNumber || 'your registered house',
        period: p,
        rentOutstandingCents: current.rentOutstandingCents,
        waterOutstandingCents: current.waterOutstandingCents,
        electricityOutstandingCents: current.electricityOutstandingCents,
        otherOutstandingCents: current.otherOutstandingCents,
        previousArrearsCents,
        paidCents: current.paidCents,
        totalOutstandingCents,
        dueDate,
        currency: estate.currency || 'KES',
      };
      const message = prefixEstate(estate.name, previewSms('billing_notification', variables));
      return {
        template,
        notificationVersion: NOTIFICATION_VERSIONS[template] || template,
        period: p,
        recipient: tenant?.phone ? maskPhone(tenant.phone) : null,
        message,
        variables,
      };
    }

    let tenantName = vars.tenantName;
    let houseNumber = vars.houseNumber;
    let phone = vars.phone;
    let estateId = vars.estateId;
    let resolvedHouseId = houseId;
    let rentCents = vars.rentCents ?? 0;
    let waterCents = vars.waterCents ?? 0;
    let electricityCents = vars.electricityCents ?? 0;
    let otherCents = vars.otherCents ?? 0;
    let previousArrearsCents = vars.previousArrearsCents ?? 0;
    let paidCents = vars.paidCents ?? 0;
    let totalOutstandingCents = vars.totalOutstandingCents;
    let dueDate = vars.dueDate;

    if (tenantId) {
      const tenant = await Tenant.findOne({
        _id: tenantId,
        clientId,
        status: 'active',
        ...estateFilterClause(estateFilter),
      });
      if (!tenant) throw Errors.TenantNotFound();
      tenantName = tenant.name;
      phone = tenant.phone;
      estateId = tenant.estateId;
      resolvedHouseId = resolvedHouseId || tenant.houseId;
    }

    if (resolvedHouseId) {
      // Prove the house is in-scope before reading balances (defense in depth).
      const house = await House.findOne({
        _id: resolvedHouseId,
        clientId,
        ...estateFilterClause(estateFilter),
      }).lean();
      if (!house) throw Errors.HouseNotFound();
      if (!houseNumber) houseNumber = house.houseNumber;

      const charges = await RentCharge.find({
        clientId,
        houseId: resolvedHouseId,
        period: p,
      }).lean();
      for (const c of charges) {
        const t = c.chargeType || 'RENT';
        if (t === 'RENT') rentCents = c.amountDueCents;
        else if (t === 'WATER') waterCents = c.amountDueCents;
        else if (t === 'ELECTRICITY') electricityCents = c.amountDueCents;
        else otherCents += c.amountDueCents;
        paidCents += c.amountPaidCents;
        if (c.dueDate && !dueDate) dueDate = dateUtil.format(c.dueDate, 'DD MMM YYYY');
      }
      const prior = await RentCharge.find({
        clientId,
        houseId: resolvedHouseId,
        period: { $lt: p },
        status: { $in: ['UNPAID', 'PARTIAL'] },
      }).lean();
      previousArrearsCents = prior.reduce((s, c) => s + Math.max(c.balanceCents, 0), 0);
      if (totalOutstandingCents == null) {
        totalOutstandingCents =
          charges.reduce((s, c) => s + Math.max(c.balanceCents, 0), 0) + previousArrearsCents;
      }
    }

    if (totalOutstandingCents == null) {
      totalOutstandingCents =
        rentCents + waterCents + electricityCents + otherCents + previousArrearsCents - paidCents;
    }

    const message = previewSms(template, {
      tenantName: tenantName || 'Tenant',
      houseNumber: houseNumber || '—',
      period: p,
      rentCents,
      waterCents,
      electricityCents,
      otherCents,
      previousArrearsCents,
      paidCents,
      totalOutstandingCents: Math.max(totalOutstandingCents, 0),
      dueDate,
      currency: 'KES',
    });

    return {
      template,
      notificationVersion: NOTIFICATION_VERSIONS[template] || template,
      period: p,
      recipient: phone ? maskPhone(phone) : null,
      message,
      variables: {
        tenantName,
        houseNumber,
        period: p,
        rentCents,
        waterCents,
        electricityCents,
        otherCents,
        previousArrearsCents,
        paidCents,
        totalOutstandingCents: Math.max(totalOutstandingCents, 0),
        dueDate,
      },
    };
  },

  /**
   * Resolve recipients for a broadcast. Financial groups reuse RentCharge balances.
   */
  async resolveBroadcastRecipients(clientId, { recipientGroup, estateId, tenantIds = [], estateFilter = null }) {
    const group = String(recipientGroup || '').toUpperCase();
    let tenants = [];

    if (group === 'ALL_TENANTS') {
      tenants = await Tenant.find({ clientId, status: 'active', ...estateFilterClause(estateFilter) }).lean();
    } else if (group === 'ESTATE') {
      if (!estateId) throw Errors.InvalidRequest('estateId is required for ESTATE broadcasts');
      const estate = await Estate.findOne({
        _id: estateId,
        clientId,
        ...estateFilterClause(estateFilter),
      });
      if (!estate) throw Errors.EstateNotFound();
      tenants = await Tenant.find({ clientId, estateId, status: 'active' }).lean();
    } else if (group === 'SELECTED_TENANTS') {
      if (!tenantIds?.length) throw Errors.InvalidRequest('tenantIds required for SELECTED_TENANTS');
      tenants = await Tenant.find({
        clientId,
        _id: { $in: tenantIds },
        status: 'active',
        ...estateFilterClause(estateFilter),
      }).lean();
      if (tenants.length !== tenantIds.length) {
        throw Errors.InvalidRequest('One or more tenantIds do not belong to your client');
      }
    } else if (group === 'ARREARS' || group === 'OUTSTANDING') {
      // Prefer Ledger running balance (authoritative). Fall back to open RentCharges
      // only for houses with no Ledger rows yet (historical compatibility).
      if (estateId) {
        const estate = await Estate.findOne({
          _id: estateId,
          clientId,
          ...estateFilterClause(estateFilter),
        });
        if (!estate) throw Errors.EstateNotFound();
      }
      const tenantFilter = {
        clientId,
        status: 'active',
        ...estateFilterClause(estateFilter),
      };
      if (estateId) tenantFilter.estateId = estateId;
      const candidates = await Tenant.find(tenantFilter).lean();
      const withBalance = [];
      for (const tenant of candidates) {
        if (!tenant.houseId) continue;
        try {
          const activeT = tenant.houseId ? await tenancyService.getActiveForHouse(clientId, tenant.houseId) : null;
          const bal = activeT
            ? await ledgerService.balanceForTenancy(clientId, activeT._id)
            : await ledgerService.balanceForHouse(clientId, tenant.houseId, estateFilter);
          const knownArrearsCents = Number.isSafeInteger(bal?.knownArrearsCents)
            ? bal.knownArrearsCents
            : null;
          if (
            bal?.verifiedFullObligation === true
            && knownArrearsCents !== null
            && knownArrearsCents > 0
          ) {
            withBalance.push(tenant);
          }
        } catch {
          // compatibility: open RentCharge balances
          const open = await RentCharge.find({
            clientId,
            houseId: tenant.houseId,
            status: { $in: ['UNPAID', 'PARTIAL'] },
            balanceCents: { $gt: 0 },
          })
            .select('balanceCents')
            .lean();
          const sum = open.reduce((s, c) => s + Math.max(c.balanceCents || 0, 0), 0);
          if (sum > 0) withBalance.push(tenant);
        }
      }
      tenants = withBalance;
    } else {
      throw Errors.InvalidRequest(
        'recipientGroup must be ALL_TENANTS, ESTATE, SELECTED_TENANTS, ARREARS, or OUTSTANDING'
      );
    }

    // Dedupe by tenant id
    const byId = new Map();
    for (const t of tenants) {
      if (t.phone) byId.set(String(t._id), t);
    }
    return [...byId.values()];
  },

  /**
   * Create one queued SmsMessage per recipient. Does not wait for provider send.
   */
  async broadcast(
    clientId,
    { recipientGroup, estateId, tenantIds, message, type = 'broadcast', period, forceResend = false, estateFilter = null },
    actorMeta = {}
  ) {
    const campaignType = type || 'broadcast';
    const isTemplate =
      campaignType === 'billing_notification' ||
      campaignType === 'arrears_notice' ||
      campaignType === 'rent_reminder';
    if (!isTemplate) {
      if (!message || message.length < 1 || message.length > 1000) {
        throw Errors.InvalidRequest('message must be 1–1000 characters for custom announcements');
      }
    }

    const recipients = await this.resolveBroadcastRecipients(clientId, {
      recipientGroup,
      estateId,
      tenantIds,
      estateFilter,
    });

    const broadcastId = crypto.randomBytes(12).toString('hex');
    const version = NOTIFICATION_VERSIONS[campaignType] || NOTIFICATION_VERSIONS.broadcast;
    const p = period || dateUtil.currentPeriod();

    let queued = 0;
    let skippedDuplicate = 0;
    const jobIds = [];

    for (const tenant of recipients) {
      let body = message;
      let smsType = campaignType === 'billing_notification' ? 'billing_notification' : 'broadcast';
      if (isTemplate) {
        try {
          const preview = await this.preview(clientId, {
            template: campaignType === 'rent_reminder' ? 'rent_reminder' : campaignType === 'arrears_notice' ? 'arrears_notice' : 'billing_notification',
            tenantId: tenant._id,
            houseId: tenant.houseId,
            period: p,
            estateFilter,
          });
          body = preview.message;
          smsType = campaignType === 'billing_notification' ? 'billing_notification' : 'broadcast';
        } catch {
          if (!message) continue; // skip tenant if template cannot render and no fallback
          body = message;
        }
      }
      if (!body || body.length < 1) continue;

      const { doc, created } = await this.queueSms({
        clientId,
        estateId: tenant.estateId,
        tenantId: tenant._id,
        houseId: tenant.houseId,
        to: tenant.phone,
        message: body,
        type: smsType,
        priority: 7,
        period: p,
        notificationVersion: version,
        broadcastId,
        forceResend,
      });
      if (created) {
        queued += 1;
        jobIds.push(String(doc._id));
      } else {
        skippedDuplicate += 1;
      }
    }

    await audit({
      clientId,
      userId: actorMeta.userId,
      action: 'SMS_BROADCAST_CREATED',
      resource: 'SmsBroadcast',
      resourceId: broadcastId,
      description: `Broadcast ${recipientGroup}: ${queued} queued, ${skippedDuplicate} deduped`,
      metadata: {
        recipientGroup,
        estateId: estateId || null,
        recipientsResolved: recipients.length,
        messagesQueued: queued,
        skippedDuplicate,
        broadcastId,
      },
      ipAddress: actorMeta.ip,
      userAgent: actorMeta.userAgent,
    });

    return {
      broadcastId,
      recipientGroup,
      recipientsResolved: recipients.length,
      messagesQueued: queued,
      skippedDuplicate,
      messagesSent: 0, // async — provider send happens in job processor
      messagesFailed: 0,
      status: 'QUEUED',
      jobIds: jobIds.slice(0, 50), // sample only
    };
  },

  async queueBillingNotificationsForEstate(clientId, estateId, period = dateUtil.currentPeriod(), { skipTenantIds = [] } = {}) {
    const estate = await Estate.findOne({ _id: estateId, clientId }).select('name currency').lean();
    if (!estate?.name) throw Errors.InvalidRequest('Billing notification estate ownership could not be verified');

    const tenancies = await Tenancy.find({
      clientId, estateId, status: { $in: ['ACTIVE', 'CLOSED'] },
    }).select('_id tenantId').lean();
    const tenancyById = new Map(tenancies.map((row) => [String(row._id), row]));
    const tenancyIdsByTenant = new Map();
    for (const tenancy of tenancies) {
      if (!tenancy.tenantId) continue;
      const key = String(tenancy.tenantId);
      if (!tenancyIdsByTenant.has(key)) tenancyIdsByTenant.set(key, []);
      tenancyIdsByTenant.get(key).push(tenancy._id);
    }

    const charges = await RentCharge.find({ clientId, estateId, period }).lean();
    if (!charges.length) {
      return { estateId: String(estateId), period, queued: 0, skipped: 0, skippedNoBill: true };
    }

    const skippedTenants = new Set((skipTenantIds || []).map(String));
    const grouped = new Map();
    const invalidGroups = new Set();
    for (const charge of charges) {
      const tenancy = charge.tenancyId ? tenancyById.get(String(charge.tenancyId)) : null;
      if (tenancy?.tenantId && charge.tenantId
        && String(tenancy.tenantId) !== String(charge.tenantId)) {
        invalidGroups.add(String(tenancy.tenantId));
        invalidGroups.add(String(charge.tenantId));
        continue;
      }
      const tenantId = tenancy?.tenantId || charge.tenantId;
      if (!tenantId || skippedTenants.has(String(tenantId))) continue;
      const key = String(tenantId);
      if (!grouped.has(key)) {
        grouped.set(key, { tenantId, charges: [], houseIds: new Set() });
      }
      const group = grouped.get(key);
      group.charges.push(charge);
      if (charge.houseId) group.houseIds.add(String(charge.houseId));
    }

    let queued = 0;
    let skipped = 0;
    for (const tenantKey of invalidGroups) {
      logger.error(
        { estateId: String(estateId), tenantId: tenantKey, period, reason: 'rent_charge_tenant_tenancy_mismatch' },
        'Billing statement skipped because RentCharge tenant and tenancy identities disagree'
      );
      skipped += 1;
    }
    const tenantRows = grouped.size
      ? await Tenant.find({ clientId, _id: { $in: [...grouped.values()].map((group) => group.tenantId) } }).lean()
      : [];
    const tenantById = new Map(tenantRows.map((row) => [String(row._id), row]));
    const houseIds = [...new Set([...grouped.values()].flatMap((group) => [...group.houseIds]))];
    const houseRows = houseIds.length
      ? await House.find({ clientId, estateId, _id: { $in: houseIds } }).select('_id houseNumber').lean()
      : [];
    const houseById = new Map(houseRows.map((row) => [String(row._id), row]));

    for (const [tenantKey, group] of grouped) {
      if (invalidGroups.has(tenantKey)) continue;
      const tenant = tenantById.get(tenantKey);
      if (!tenant?.phone) {
        logger.warn(
          { estateId: String(estateId), tenantId: tenantKey, period, reason: 'tenant_phone_missing' },
          'Billing notification skipped because tenant phone is missing'
        );
        skipped += 1;
        continue;
      }

      try {
        const current = aggregateRentCharges(group.charges);
        const tenantTenancyIds = tenancyIdsByTenant.get(tenantKey) || [];
        const previousFilter = {
          clientId, estateId, period: { $lt: period },
          status: { $in: ['UNPAID', 'PARTIAL'] },
          $or: [
            ...(tenantTenancyIds.length ? [{ tenancyId: { $in: tenantTenancyIds } }] : []),
            { tenantId: group.tenantId },
          ],
        };
        const previous = await RentCharge.find(previousFilter).lean();
        const previousArrearsCents = sumOutstandingCents(previous);
        const totalOutstandingCents = current.totalOutstandingCents + previousArrearsCents;
        requireTemplateCents(totalOutstandingCents, 'totalOutstandingCents');

        const houseNumbers = [...group.houseIds]
          .map((id) => houseById.get(id)?.houseNumber)
          .filter(Boolean);
        const dueDate = current.dueDates
          .map((date) => dateUtil.format(date, 'DD MMM YYYY'))
          .join(', ') || null;
        const message = previewSms('billing_notification', {
          tenantName: tenant.name,
          houseNumber: houseNumbers.join(', ') || 'your registered house',
          period,
          rentOutstandingCents: current.rentOutstandingCents,
          waterOutstandingCents: current.waterOutstandingCents,
          electricityOutstandingCents: current.electricityOutstandingCents,
          otherOutstandingCents: current.otherOutstandingCents,
          previousArrearsCents,
          paidCents: current.paidCents,
          totalOutstandingCents,
          dueDate,
          currency: estate.currency || 'KES',
        });
        const idempotencyKey = 'billing:' + String(clientId) + ':' + String(estateId) + ':' + tenantKey + ':' + period + ':v2';
        const result = await this.queueSms({
          clientId,
          estateId,
          tenantId: tenant._id,
          houseId: group.houseIds.size === 1 ? [...group.houseIds][0] : null,
          to: tenant.phone,
          message,
          type: 'billing_notification',
          priority: 7,
          period,
          notificationVersion: 'billing_notification:v2',
          idempotencyKey,
        });
        if (result.created) queued += 1;
        else skipped += 1;
      } catch (err) {
        logger.warn(
          { estateId: String(estateId), tenantId: tenantKey, code: err.code || 'BILLING_SMS_INVALID' },
          'Billing notification skipped because financial source data was not valid'
        );
        skipped += 1;
      }
    }
    return { estateId: String(estateId), period, queued, skipped };
  },

  history: (clientId, estateFilter, { limit = 100 } = {}) =>
    SmsMessage.find({ clientId, ...estateFilterClause(estateFilter) })
      .sort({ createdAt: -1 })
      .limit(limit),

  /**
   * Claim the next ORDINARY (standard) SMS batch. Positive allowlist only: explicit null,
   * SUPPRESSED, G5_PROTECTED or any unexpected value is never claimed here. Protected
   * messages are dispatched exclusively by g5ProtectedSms.service.
   */
  async _claimNextBatch(limit = 20) {
    const claimed = [];
    for (let i = 0; i < limit; i += 1) {
      const job = await SmsMessage.findOneAndUpdate(
        {
          status: 'queued',
          $and: [
            { $or: [{ deliveryMode: 'STANDARD' }, { deliveryMode: { $exists: false } }] },
            { $or: [{ dispatchMode: 'ENABLED' }, { dispatchMode: { $exists: false } }] },
            { $or: [{ nextRetryAt: null }, { nextRetryAt: { $exists: false } }, { nextRetryAt: { $lte: new Date() } }] },
          ],
        },
        { $set: { status: 'processing', processingStartedAt: new Date() } },
        { sort: { priority: -1, createdAt: 1 }, new: true }
      );
      if (!job) break;
      claimed.push(job);
    }
    return claimed;
  },

  async processQueuedBatch(limit = 50) {
    const provider = getSmsProvider('celcom');
    const jobs = await this._claimNextBatch(limit);

    for (const job of jobs) {
      const result = await provider.send(job.phoneNumber, job.message, job.idempotencyKey);

      if (result.success) {
        job.status = 'sent';
        job.sentAt = new Date();
        job.providerMessageId = result.providerMessageId;
        await job.save();
        await audit({
          clientId: job.clientId,
          estateId: job.estateId,
          action: 'SMS_SENT',
          resource: 'SmsMessage',
          resourceId: job._id,
          metadata: { providerMessageId: result.providerMessageId, type: job.type },
        });
      } else if (result.status === 'unknown') {
        job.status = 'unknown';
        job.failureReason = result.errorMessage;
        await job.save();
      } else {
        job.retryCount += 1;
        if (result.retryable && job.retryCount < job.maxRetries) {
          job.status = 'queued';
          job.nextRetryAt = new Date(Date.now() + 60_000);
        } else {
          job.status = 'failed';
          job.failedAt = new Date();
          await audit({
            clientId: job.clientId,
            estateId: job.estateId,
            action: 'SMS_FAILED',
            resource: 'SmsMessage',
            resourceId: job._id,
            metadata: { reason: result.errorMessage, type: job.type },
          });
        }
        job.failureReason = result.errorMessage;
        await job.save();
      }
      logger.info({ jobId: job._id.toString(), status: job.status }, 'SMS job processed');
    }
    return jobs.length;
  },
};
