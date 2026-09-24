// Deposit lifecycle — liability tracking SEPARATE from rent revenue.
// Deposit held/refund/deduction amounts live on the Deposit document (source of truth for deposit liability).
// Rent account balance remains Ledger CHARGE/PAYMENT only — deposit events must not alter rent running balance.
import { Deposit } from '../models/Deposit.js';
import { Tenant } from '../models/Tenant.js';
import { House } from '../models/House.js';
import { Errors } from '../utils/errors.js';
import { estateFilterClause } from '../utils/estateFilter.js';
import { audit } from './audit.service.js';

function recomputeStatus(dep) {
  const deducted = (dep.deductions || []).reduce((s, d) => s + (d.amountCents || 0), 0);
  if (dep.refundedCents > 0 && dep.heldCents === 0) return 'REFUNDED';
  if (dep.settledAt) return 'SETTLED';
  if (dep.paidCents >= dep.requiredCents && dep.requiredCents > 0) return 'HELD';
  if (dep.paidCents > 0) return 'PARTIAL';
  return 'REQUIRED';
}

export const depositService = {
  async getForTenant(clientId, tenantId, estateFilter = null) {
    const tenant = await Tenant.findOne({
      _id: tenantId,
      clientId,
      ...estateFilterClause(estateFilter),
    }).lean();
    if (!tenant) throw Errors.TenantNotFound();
    const dep = await Deposit.findOne({ clientId, tenantId }).lean();
    return { tenant, deposit: dep };
  },

  async ensureRequired(clientId, { tenantId, requiredCents, moveInDate }, actor, estateFilter = null) {
    const tenant = await Tenant.findOne({
      _id: tenantId,
      clientId,
      ...estateFilterClause(estateFilter),
    });
    if (!tenant) throw Errors.TenantNotFound();
    const amount = Math.max(0, Math.trunc(Number(requiredCents) || 0));
    let dep = await Deposit.findOne({ clientId, tenantId });
    if (dep) {
      if (dep.paidCents === 0) {
        dep.requiredCents = amount;
        dep.moveInDate = moveInDate || dep.moveInDate;
        dep.status = recomputeStatus(dep);
        await dep.save();
      }
      return dep;
    }
    dep = await Deposit.create({
      clientId,
      estateId: tenant.estateId,
      houseId: tenant.houseId,
      tenantId: tenant._id,
      requiredCents: amount,
      paidCents: 0,
      heldCents: 0,
      refundedCents: 0,
      status: amount > 0 ? 'REQUIRED' : 'HELD',
      moveInDate: moveInDate || tenant.moveInDate,
    });
    await audit({
      clientId,
      userId: actor?._id,
      action: 'DEPOSIT_REQUIRED',
      resource: 'Deposit',
      resourceId: dep._id,
      metadata: { requiredCents: amount, tenantId: String(tenantId) },
    });
    return dep;
  },

  async recordPayment(clientId, tenantId, amountCents, actor, estateFilter = null) {
    const amount = Math.max(0, Math.trunc(Number(amountCents) || 0));
    if (amount <= 0) throw Errors.InvalidRequest('Deposit payment amount must be positive');

    const tenant = await Tenant.findOne({
      _id: tenantId,
      clientId,
      ...estateFilterClause(estateFilter),
    });
    if (!tenant) throw Errors.TenantNotFound();

    let dep = await Deposit.findOne({ clientId, tenantId });
    if (!dep) {
      dep = await Deposit.create({
        clientId,
        estateId: tenant.estateId,
        houseId: tenant.houseId,
        tenantId: tenant._id,
        requiredCents: amount,
        paidCents: 0,
        heldCents: 0,
        refundedCents: 0,
        status: 'REQUIRED',
      });
    }

    dep.paidCents += amount;
    dep.heldCents += amount;
    dep.status = recomputeStatus(dep);
    await dep.save();

    await audit({
      clientId,
      userId: actor?._id,
      action: 'DEPOSIT_RECEIVED',
      resource: 'Deposit',
      resourceId: dep._id,
      metadata: { amountCents: amount },
    });
    return dep;
  },

  async addDeduction(clientId, tenantId, { amountCents, reason, notes }, actor, estateFilter = null) {
    const amount = Math.max(0, Math.trunc(Number(amountCents) || 0));
    if (amount <= 0) throw Errors.InvalidRequest('Deduction amount must be positive');
    if (!reason?.trim()) throw Errors.InvalidRequest('Deduction reason is required');

    const tenant = await Tenant.findOne({
      _id: tenantId,
      clientId,
      ...estateFilterClause(estateFilter),
    });
    if (!tenant) throw Errors.TenantNotFound();

    const dep = await Deposit.findOne({ clientId, tenantId });
    if (!dep) throw Errors.NotFound('Deposit not found');
    if (amount > dep.heldCents) throw Errors.InvalidRequest('Deduction exceeds held deposit');

    dep.deductions.push({
      amountCents: amount,
      reason: reason.trim(),
      notes: notes || '',
      actorUserId: actor?._id,
      deductedAt: new Date(),
    });
    dep.heldCents -= amount;
    dep.status = recomputeStatus(dep);
    await dep.save();

    await audit({
      clientId,
      userId: actor?._id,
      action: 'DEPOSIT_DEDUCTION',
      resource: 'Deposit',
      resourceId: dep._id,
      metadata: { amountCents: amount, reason: reason.trim() },
    });
    return dep;
  },

  async settleMoveOut(clientId, tenantId, actor, estateFilter = null) {
    const tenant = await Tenant.findOne({
      _id: tenantId,
      clientId,
      ...estateFilterClause(estateFilter),
    });
    if (!tenant) throw Errors.TenantNotFound();

    const dep = await Deposit.findOne({ clientId, tenantId });
    if (!dep) throw Errors.NotFound('Deposit not found');

    const refundDue = Math.max(0, dep.heldCents);
    if (refundDue > 0) {
      dep.refundedCents += refundDue;
      dep.heldCents = 0;
    }
    dep.settledAt = new Date();
    dep.status = recomputeStatus(dep);
    await dep.save();

    tenant.status = 'moved_out';
    tenant.moveOutDate = new Date();
    await tenant.save();

    await House.findOneAndUpdate(
      { _id: tenant.houseId, clientId },
      { $set: { status: 'vacant', tenantId: null } }
    );

    await audit({
      clientId,
      userId: actor?._id,
      action: 'DEPOSIT_SETTLED',
      resource: 'Deposit',
      resourceId: dep._id,
      metadata: { refundDueCents: refundDue },
    });

    return {
      deposit: dep,
      settlement: {
        heldBefore: refundDue + (dep.deductions || []).reduce((s, d) => s + d.amountCents, 0),
        deductionsCents: (dep.deductions || []).reduce((s, d) => s + d.amountCents, 0),
        refundDueCents: refundDue,
      },
    };
  },
};
