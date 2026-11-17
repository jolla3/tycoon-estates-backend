// src/services/subscription.service.js
//
// Client-scoped subscription lifecycle. No payment provider integration —
// Entitlement/plan mutation authority lives in createForManager/updateByManager only.
import { Subscription } from '../models/Subscription.js';
import { Errors } from '../utils/errors.js';

/** Ordered plan ranks — higher number = higher tier. Used for upgrade-only checks. */
export const PLAN_RANK = { trial: 0, basic: 1, pro: 2 };
export const PLANS = ['trial', 'basic', 'pro'];

export const PLAN_CATALOG = [
  { plan: 'trial', label: 'Trial', description: 'Evaluation plan for new clients.' },
  { plan: 'basic', label: 'Basic', description: 'Core estate and rent monitoring.' },
  { plan: 'pro', label: 'Pro', description: 'Full feature set for growing portfolios.' },
];

export const PRODUCT_VALUES = ['BANKING', 'MPESA'];

function toDate(v, field) {
  const d = new Date(v);
  if (Number.isNaN(d.getTime())) throw Errors.InvalidRequest(`${field} is not a valid date`);
  return d;
}

/** Validates Manager-supplied fields; undefined = untouched, endDate null = explicit clear. */
function validateManagerFields({ plan, products, startDate, endDate }) {
  const out = {};
  if (plan !== undefined) {
    if (!PLANS.includes(plan)) throw Errors.InvalidRequest(`Invalid plan. Allowed: ${PLANS.join(', ')}`);
    out.plan = plan;
  }
  if (products !== undefined) {
    if (!Array.isArray(products) || products.some((p) => !PRODUCT_VALUES.includes(p))) {
      throw Errors.InvalidRequest(`Invalid products. Allowed: ${PRODUCT_VALUES.join(', ')}`);
    }
    if (new Set(products).size !== products.length) throw Errors.InvalidRequest('Duplicate products are not allowed');
    out.products = products;
  }
  if (startDate !== undefined) out.startDate = toDate(startDate, 'startDate');
  if (endDate !== undefined) out.endDate = endDate === null ? null : toDate(endDate, 'endDate');
  if (out.startDate && out.endDate && out.endDate < out.startDate) {
    throw Errors.InvalidRequest('endDate must not be before startDate');
  }
  return out;
}

function snapshot(sub) {
  return {
    plan: sub.plan,
    status: sub.status,
    products: [...(sub.products || [])],
    startDate: sub.startDate || null,
    endDate: sub.endDate || null,
  };
}

function toPublic(sub) {
  if (!sub) return null;
  const s = typeof sub.toObject === 'function' ? sub.toObject() : sub;
  return {
    id: String(s._id),
    clientId: String(s.clientId),
    plan: s.plan,
    status: s.status,
    startDate: s.startDate,
    endDate: s.endDate || null,
    products: Array.isArray(s.products) ? s.products : [],
    assignedByUserId: s.assignedByUserId ? String(s.assignedByUserId) : null,
    lastChangedByUserId: s.lastChangedByUserId ? String(s.lastChangedByUserId) : null,
    createdAt: s.createdAt,
    updatedAt: s.updatedAt,
  };
}

export const subscriptionService = {
  get: (clientId) => Subscription.findOne({ clientId }),

  async getPublic(clientId) {
    const sub = await Subscription.findOne({ clientId });
    return toPublic(sub);
  },

  async isActive(clientId) {
    const sub = await Subscription.findOne({ clientId });
    return !!sub && sub.status === 'active';
  },

  /**
   * Default subscription for signup/default creation ONLY: trial/active, NO products.
   * Idempotent. Never grants entitlement; never used for Manager-assigned plans.
   */
  async ensureDefaultForClient(clientId, { session } = {}) {
    const opts = { upsert: true, new: true, setDefaultsOnInsert: true, ...(session ? { session } : {}) };
    try {
      return await Subscription.findOneAndUpdate(
        { clientId },
        { $setOnInsert: { clientId, plan: 'trial', status: 'active', products: [], startDate: new Date() } },
        opts
      );
    } catch (err) {
      if (err?.code === 11000 || err?.codeName === 'DuplicateKey') {
        const existing = await Subscription.findOne({ clientId }).session(session || null);
        if (existing) return existing;
      }
      throw err;
    }
  },

  /**
   * Manager-assigned creation. Insert-only: a duplicate subscription FAILS, it is never
   * reused or overwritten. actor must be the real authenticated Manager.
   */
  async createForManager(clientId, { plan = 'trial', products = [], startDate, endDate } = {}, actor, { session } = {}) {
    const clean = validateManagerFields({ plan, products, startDate, endDate });
    if (!actor?._id) throw Errors.InvalidRequest('An authenticated actor is required');
    try {
      const [doc] = await Subscription.create([{
        clientId,
        plan: clean.plan ?? 'trial',
        status: 'active',
        products: clean.products ?? [],
        startDate: clean.startDate ?? new Date(),
        ...(clean.endDate ? { endDate: clean.endDate } : {}),
        assignedByUserId: actor._id,
        lastChangedByUserId: actor._id,
      }], session ? { session } : undefined);
      return doc;
    } catch (err) {
      if (err?.code === 11000) throw Errors.Conflict('Client already has a subscription');
      throw err;
    }
  },

  /**
   * Sole ongoing mutation path (Manager only). Partial update of plan / products / dates.
   * Status is intentionally NOT mutable here. endDate: null clears it explicitly.
   * Returns { before, after } safe snapshots for the required audit record.
   */
  async updateByManager(clientId, patch, actor, { session } = {}) {
    if (!actor?._id) throw Errors.InvalidRequest('An authenticated actor is required');
    const clean = validateManagerFields(patch);
    const sub = await Subscription.findOne({ clientId }).session(session || null);
    if (!sub) throw Errors.NotFound('Subscription not found for client');
    const before = snapshot(sub);

    if (clean.plan !== undefined) sub.plan = clean.plan;
    if (clean.products !== undefined) sub.products = clean.products;
    if (clean.startDate !== undefined) sub.startDate = clean.startDate;
    if (clean.endDate !== undefined) sub.endDate = clean.endDate === null ? undefined : clean.endDate;
    if (sub.endDate && sub.startDate && sub.endDate < sub.startDate) {
      throw Errors.InvalidRequest('endDate must not be before startDate');
    }
    sub.lastChangedByUserId = actor._id;
    await sub.save(session ? { session } : undefined);
    return { subscription: toPublic(sub), before, after: snapshot(sub) };
  },

  catalog() {
    return PLAN_CATALOG;
  },
};
