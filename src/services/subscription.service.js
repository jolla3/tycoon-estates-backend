// src/services/subscription.service.js
//
// Client-scoped subscription lifecycle. No payment provider integration —
// plan changes are authorized application-state updates only.
import { Subscription } from '../models/Subscription.js';
import { Errors } from '../utils/errors.js';
import { audit } from './audit.service.js';

/** Ordered plan ranks — higher number = higher tier. Used for upgrade-only checks. */
export const PLAN_RANK = { trial: 0, basic: 1, pro: 2 };
export const PLANS = ['trial', 'basic', 'pro'];

export const PLAN_CATALOG = [
  { plan: 'trial', label: 'Trial', description: 'Evaluation plan for new clients.' },
  { plan: 'basic', label: 'Basic', description: 'Core estate and rent monitoring.' },
  { plan: 'pro', label: 'Pro', description: 'Full feature set for growing portfolios.' },
];

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
   * Ensure a subscription row exists for a client (idempotent).
   * Client-scoped only — never writes estateId.
   * Atomic upsert on clientId; safe under concurrent provision retries.
   */
  async ensureForClient(clientId, { plan = 'trial', status = 'active' } = {}, { session } = {}) {
    const opts = {
      upsert: true,
      new: true,
      setDefaultsOnInsert: true,
      ...(session ? { session } : {}),
    };
    try {
      const doc = await Subscription.findOneAndUpdate(
        { clientId },
        {
          $setOnInsert: {
            clientId,
            plan,
            status,
            startDate: new Date(),
          },
        },
        opts
      );
      return doc;
    } catch (err) {
      // Unique on clientId race, or residual legacy index — recover by clientId
      if (err?.code === 11000 || err?.codeName === 'DuplicateKey') {
        const existing = await Subscription.findOne({ clientId }).session(session || null);
        if (existing) return existing;
      }
      throw err;
    }
  },

  /** @deprecated prefer ensureForClient / upgrade */
  setPlan: (clientId, plan) =>
    Subscription.findOneAndUpdate({ clientId }, { plan }, { new: true, upsert: true }),

  catalog() {
    return PLAN_CATALOG;
  },

  /**
   * Upgrade-only plan change for the authenticated client's subscription.
   * clientId must come from session context — never from the request body.
   */
  async upgrade(clientId, requestedPlan, actor, reqMeta = {}) {
    if (!PLANS.includes(requestedPlan)) {
      throw Errors.InvalidRequest(`Invalid plan. Allowed: ${PLANS.join(', ')}`);
    }

    let sub = await Subscription.findOne({ clientId });
    if (!sub) {
      sub = await this.ensureForClient(clientId, { plan: 'trial', status: 'active' });
    }

    const currentRank = PLAN_RANK[sub.plan] ?? 0;
    const nextRank = PLAN_RANK[requestedPlan] ?? -1;
    if (nextRank <= currentRank) {
      throw Errors.InvalidRequest(
        `Cannot upgrade from "${sub.plan}" to "${requestedPlan}". Choose a higher plan.`
      );
    }

    sub.plan = requestedPlan;
    if (sub.status === 'canceled') sub.status = 'active';
    await sub.save();

    await audit({
      clientId,
      userId: actor?._id,
      action: 'SUBSCRIPTION_UPGRADED',
      resource: 'Subscription',
      resourceId: sub._id,
      description: `Subscription upgraded to ${requestedPlan}`,
      metadata: { plan: requestedPlan, previousPlan: currentRank },
      ipAddress: reqMeta.ip,
      userAgent: reqMeta.userAgent,
    });

    return toPublic(sub);
  },
};
