// src/services/tenantAccount.service.js — Tenant-level account view (read-only DTOs).
// Scoped by Client AND the caller's enforced estate set. Never returns link digests,
// evidence envelopes, raw SMS, or payer PII.
import { Tenant } from '../models/Tenant.js';
import { Tenancy } from '../models/Tenancy.js';
import { RentCharge } from '../models/RentCharge.js';
import { Payment } from '../models/Payment.js';
import { PaymentAllocation } from '../models/PaymentAllocation.js';
import { MpesaSmsSubmission } from '../models/MpesaSmsSubmission.js';
import { MpesaSubmissionLink } from '../models/MpesaSubmissionLink.js';
import { creditBalanceCents } from './tenantCredit.service.js';
import { estateFilterClause } from '../utils/estateFilter.js';
import { Errors } from '../utils/errors.js';

export async function loadScopedTenant(clientId, estateFilter, tenantId) {
  const tenant = await Tenant.findOne({ _id: tenantId, clientId, ...estateFilterClause(estateFilter) });
  if (!tenant) throw Errors.TenantNotFound();
  return tenant;
}

export const tenantAccountService = {
  async view({ clientId, estateFilter, tenantId }) {
    const tenant = await loadScopedTenant(clientId, estateFilter, tenantId);
    const scope = { clientId, estateId: tenant.estateId, tenantId: tenant._id };
    const tenancies = await Tenancy.find({ ...scope, status: { $in: ['ACTIVE', 'CLOSED'] } }).sort({ startAt: 1, _id: 1 });
    const ids = tenancies.map((t) => t._id);
    const owed = ids.length ? await RentCharge.aggregate([
      { $match: { clientId, estateId: tenant.estateId, tenancyId: { $in: ids }, status: { $in: ['UNPAID', 'PARTIAL'] }, balanceCents: { $gt: 0 } } },
      { $group: { _id: '$tenancyId', outstandingCents: { $sum: '$balanceCents' } } },
    ]) : [];
    const owedBy = new Map(owed.map((o) => [String(o._id), o.outstandingCents]));
    const row = (t) => ({
      tenancyId: t._id, houseId: t.houseId, status: t.status, startAt: t.startAt, endAt: t.endAt,
      outstandingCents: owedBy.get(String(t._id)) || 0,
    });
    const activeTenancies = tenancies.filter((t) => t.status === 'ACTIVE').map(row);
    const closedTenancyArrears = tenancies.filter((t) => t.status === 'CLOSED').map(row).filter((r) => r.outstandingCents > 0);
    const combinedOutstandingCents = [...owedBy.values()].reduce((a, b) => a + b, 0);
    const creditCents = await creditBalanceCents(scope);

    const link = await MpesaSubmissionLink.findOne(scope).select('status linkVersion rotatedAt revokedAt');
    const submissions = await MpesaSmsSubmission.find({
      ...scope, state: { $in: ['RECEIVED', 'PARSED', 'UNMATCHED', 'CONFLICTING', 'MANUAL_REVIEW'] },
    }).sort({ createdAt: -1 }).limit(50).select('state stateReason amountCents createdAt');

    return {
      tenantId: tenant._id, estateId: tenant.estateId,
      activeTenancies, closedTenancyArrears,
      combinedOutstandingCents, creditCents,
      // net position is informational arithmetic over integers; credit is applied automatically, not netted here
      link: link ? { status: link.status, version: link.linkVersion, rotatedAt: link.rotatedAt, revokedAt: link.revokedAt } : null,
      pendingSubmissions: submissions.map((s) => ({ id: s._id, state: s.state, reason: s.stateReason, amountCents: s.amountCents, createdAt: s.createdAt })),
    };
  },

  async payments({ clientId, estateFilter, tenantId, limit = 50 }) {
    const tenant = await loadScopedTenant(clientId, estateFilter, tenantId);
    const payments = await Payment.find({ clientId, estateId: tenant.estateId, tenantId: tenant._id })
      .sort({ paymentDate: -1, _id: -1 }).limit(Math.min(Number(limit) || 50, 200));
    const allocs = await PaymentAllocation.find({ clientId, paymentId: { $in: payments.map((p) => p._id) } });
    const byPay = new Map();
    for (const a of allocs) {
      const k = String(a.paymentId);
      if (!byPay.has(k)) byPay.set(k, []);
      byPay.get(k).push({ rentChargeId: a.rentChargeId, tenancyId: a.tenancyId, amountCents: a.amountCents, period: a.period, chargeType: a.chargeType });
    }
    return payments.map((p) => ({
      id: p._id, origin: p.origin, tenancyId: p.tenancyId, amountCents: p.amountCents, paymentDate: p.paymentDate,
      status: p.status, receiptGroupId: p.mpesaReceiptId || null, allocations: byPay.get(String(p._id)) || [],
    }));
  },
};
