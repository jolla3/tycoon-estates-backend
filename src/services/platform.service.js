// src/services/platform.service.js
//
// SUPER_ADMIN platform control plane. All queries are platform-scoped
// (across clients). Never used by CLIENT_OWNER / CLIENT_ADMIN / STAFF.

import mongoose from 'mongoose';
import bcrypt from 'bcryptjs';
import { Client } from '../models/Client.js';
import { User } from '../models/User.js';
import { Estate } from '../models/Estate.js';
import { House } from '../models/House.js';
import { Tenant } from '../models/Tenant.js';
import { Subscription } from '../models/Subscription.js';
import { subscriptionService } from './subscription.service.js';
import { AuditLog } from '../models/AuditLog.js';
import { isDatabaseReady } from '../config/database.js';
import { checkRedisHealth, isRedisReady } from '../config/redis.js';
import { env } from '../config/environment.js';
import { Errors } from '../utils/errors.js';
import { audit, auditRequired } from './audit.service.js';
import { getPlatformHealth } from './platformHealth.service.js';
import {
  bankingSummaryByClient, mpesaSummaryByClient, buildClientDirectoryFilter,
  integrationDistributions, emptyBanking, emptyMpesa, pageParams,
  listBankingIntegrations, listMpesaIntegrations,
} from './platformIntegrations.service.js';
import { checkEntitlement } from './entitlement.service.js';
import { getBackgroundJobStatus } from '../jobs/scheduler.js';

const SALT_ROUNDS = 12;

const SENSITIVE_KEY = /pass(word)?|secret|token|credential|api[-_]?key|authorization|envelope|hash|payload|accountnumber|msisdn|phone|cookie|session/i;

/** Recursively redacts sensitive keys; bounded depth/size so metadata can never leak raw payloads. */
export function redactMetadata(value, depth = 0) {
  if (value == null || depth > 4) return value == null ? value : '[truncated]';
  if (Array.isArray(value)) return value.slice(0, 50).map((v) => redactMetadata(v, depth + 1));
  if (typeof value === 'object') {
    if (typeof value.toHexString === 'function') return String(value);
    if (value instanceof Date) return value;
    const out = {};
    for (const [k, v] of Object.entries(value).slice(0, 50)) {
      out[k] = SENSITIVE_KEY.test(k) ? '[redacted]' : redactMetadata(v, depth + 1);
    }
    return out;
  }
  return typeof value === 'string' ? value.slice(0, 500) : value;
}

function toSafeAudit(a) {
  const actor = a.userId && typeof a.userId === 'object' && a.userId.email !== undefined ? a.userId : null;
  const client = a.clientId && typeof a.clientId === 'object' && a.clientId.name !== undefined ? a.clientId : null;
  return {
    id: String(a._id),
    createdAt: a.createdAt,
    action: a.action,
    resource: a.resource || null,
    resourceId: a.resourceId || null,
    description: a.description || null,
    actor: actor
      ? { id: String(actor._id), name: actor.name, email: actor.email, role: actor.role }
      : { id: a.userId ? String(a.userId._id || a.userId) : null },
    targetClient: client
      ? { id: String(client._id), name: client.name, isActive: client.isActive }
      : { id: a.clientId ? String(a.clientId._id || a.clientId) : null },
    metadata: redactMetadata(a.metadata),
    ipAddress: a.ipAddress || null,
    userAgent: a.userAgent ? String(a.userAgent).slice(0, 200) : null,
  };
}

export const platformService = {
  // ── Overview (aggregated, few queries) ──────────────────────────────
  async overview() {
    const [
      clientStats,
      estateCount,
      houseStats,
      tenantStats,
      staffStats,
      subscriptionStats,
      integrations,
    ] = await Promise.all([
      Client.aggregate([
        {
          $group: {
            _id: null,
            totalClients: { $sum: 1 },
            activeClients: { $sum: { $cond: ['$isActive', 1, 0] } },
            inactiveClients: { $sum: { $cond: ['$isActive', 0, 1] } },
          },
        },
      ]),
      Estate.countDocuments({ isActive: true }),
      House.aggregate([
        {
          $group: {
            _id: null,
            totalHouses: { $sum: 1 },
            occupiedHouses: { $sum: { $cond: [{ $eq: ['$status', 'occupied'] }, 1, 0] } },
            vacantHouses: { $sum: { $cond: [{ $eq: ['$status', 'vacant'] }, 1, 0] } },
          },
        },
      ]),
      Tenant.aggregate([
        {
          $group: {
            _id: null,
            totalTenants: { $sum: 1 },
            activeTenants: { $sum: { $cond: [{ $eq: ['$status', 'active'] }, 1, 0] } },
          },
        },
      ]),
      User.aggregate([
        {
          $match: { role: { $in: ['CLIENT_OWNER', 'CLIENT_ADMIN', 'STAFF'] } },
        },
        {
          $group: {
            _id: null,
            totalStaff: { $sum: 1 },
            activeStaff: { $sum: { $cond: ['$isActive', 1, 0] } },
            inactiveStaff: { $sum: { $cond: ['$isActive', 0, 1] } },
          },
        },
      ]),
      Subscription.aggregate([
        {
          $group: {
            _id: null,
            activeSubscriptions: { $sum: { $cond: [{ $eq: ['$status', 'active'] }, 1, 0] } },
            pastDueSubscriptions: { $sum: { $cond: [{ $eq: ['$status', 'past_due'] }, 1, 0] } },
            canceledSubscriptions: { $sum: { $cond: [{ $eq: ['$status', 'canceled'] }, 1, 0] } },
          },
        },
      ]),
      integrationDistributions(),
    ]);

    const c = clientStats[0] || { totalClients: 0, activeClients: 0, inactiveClients: 0 };
    const h = houseStats[0] || { totalHouses: 0, occupiedHouses: 0, vacantHouses: 0 };
    const t = tenantStats[0] || { totalTenants: 0, activeTenants: 0 };
    const s = staffStats[0] || { totalStaff: 0, activeStaff: 0, inactiveStaff: 0 };
    const sub = subscriptionStats[0] || {
      activeSubscriptions: 0,
      pastDueSubscriptions: 0,
      canceledSubscriptions: 0,
    };

    return {
      totalClients: c.totalClients,
      activeClients: c.activeClients,
      inactiveClients: c.inactiveClients,
      totalEstates: estateCount,
      totalHouses: h.totalHouses,
      occupiedHouses: h.occupiedHouses,
      vacantHouses: h.vacantHouses,
      totalTenants: t.totalTenants,
      activeTenants: t.activeTenants,
      totalStaff: s.totalStaff,
      activeStaff: s.activeStaff,
      inactiveStaff: s.inactiveStaff,
      activeSubscriptions: sub.activeSubscriptions,
      pastDueSubscriptions: sub.pastDueSubscriptions,
      canceledSubscriptions: sub.canceledSubscriptions,
      // Superadmin V2 additions. Entitlements (Subscription.products) and integration
      // readiness are reported separately and never derived from one another.
      productAssignments: integrations.productAssignments,
      bankingIntegration: integrations.banking,
      mpesaIntegration: integrations.mpesa,
    };
  },

  // ── Clients ─────────────────────────────────────────────────────────
  async listClients(query = {}) {
    const { page, limit, skip } = pageParams(query);
    const filter = await buildClientDirectoryFilter(query);

    const [items, total] = await Promise.all([
      Client.find(filter).sort({ createdAt: -1, _id: 1 }).skip(skip).limit(limit).lean(),
      Client.countDocuments(filter),
    ]);

    // Batched enrichment: one query/aggregate per collection for the whole page.
    const clientIds = items.map((c) => c._id);
    const [owners, estateCounts, houseCounts, subs, banking, mpesa] = await Promise.all([
      User.find({ clientId: { $in: clientIds }, role: 'CLIENT_OWNER' })
        .select('clientId name email phone isActive').lean(),
      Estate.aggregate([
        { $match: { clientId: { $in: clientIds } } },
        { $group: { _id: '$clientId', count: { $sum: 1 } } },
      ]),
      House.aggregate([
        { $match: { clientId: { $in: clientIds } } },
        { $group: { _id: '$clientId', count: { $sum: 1 } } },
      ]),
      Subscription.find({ clientId: { $in: clientIds } }).lean(),
      bankingSummaryByClient(clientIds),
      mpesaSummaryByClient(clientIds),
    ]);

    const ownerByClient = new Map(owners.map((o) => [String(o.clientId), o]));
    const estatesByClient = new Map(estateCounts.map((e) => [String(e._id), e.count]));
    const housesByClient = new Map(houseCounts.map((h) => [String(h._id), h.count]));
    const subByClient = new Map(subs.map((x) => [String(x.clientId), x]));

    return {
      items: items.map((c) => {
        const k = String(c._id);
        const sub = subByClient.get(k);
        return {
          ...c,
          owner: ownerByClient.get(k) || null,
          estateCount: estatesByClient.get(k) || 0,
          houseCount: housesByClient.get(k) || 0,
          // Missing subscription is distinct from a subscription with empty products.
          subscription: sub
            ? { present: true, plan: sub.plan, status: sub.status, startDate: sub.startDate, endDate: sub.endDate || null }
            : { present: false },
          products: sub?.products || [],
          banking: banking.get(k) || emptyBanking(),
          mpesa: mpesa.get(k) || emptyMpesa(false),
        };
      }),
      total,
      page,
      limit,
    };
  },

  async getClient(clientId) {
    if (!mongoose.isValidObjectId(clientId)) throw Errors.NotFound('Client not found');
    const client = await Client.findById(clientId).lean();
    if (!client) throw Errors.NotFound('Client not found');

    // Every query below is explicitly scoped to this clientId. Read-only; works for
    // inactive clients (platform diagnostics) without any owner impersonation.
    const [owner, subscription, estateCount, houseCount, tenantCount, staffCount, banking, mpesa] =
      await Promise.all([
        User.findOne({ clientId, role: 'CLIENT_OWNER' }).select('name email phone isActive lastLoginAt createdAt').lean(),
        Subscription.findOne({ clientId }).lean(),
        Estate.countDocuments({ clientId }),
        House.countDocuments({ clientId }),
        Tenant.countDocuments({ clientId, status: 'active' }),
        User.countDocuments({ clientId, role: { $in: ['CLIENT_OWNER', 'CLIENT_ADMIN', 'STAFF'] } }),
        bankingSummaryByClient([clientId]),
        mpesaSummaryByClient([clientId], { includeProfiles: true }),
      ]);

    const key = String(client._id);
    return {
      ...client,
      owner: owner || null,
      subscription: subscription
        ? {
            present: true,
            id: String(subscription._id),
            plan: subscription.plan,
            status: subscription.status,
            startDate: subscription.startDate,
            endDate: subscription.endDate || null,
            products: subscription.products || [],
            assignedByUserId: subscription.assignedByUserId ? String(subscription.assignedByUserId) : null,
            lastChangedByUserId: subscription.lastChangedByUserId ? String(subscription.lastChangedByUserId) : null,
            createdAt: subscription.createdAt,
            updatedAt: subscription.updatedAt,
          }
        : { present: false },
      products: subscription?.products || [],
      estateCount,
      houseCount,
      activeTenantCount: tenantCount,
      staffCount,
      banking: banking.get(key) || emptyBanking(),
      mpesa: mpesa.get(key) || emptyMpesa(true),
    };
  },

  /**
   * Atomic client + owner + subscription provisioning.
   * Does not create SUPER_ADMIN users. Password is never returned.
   */
  async provisionClient(
    { clientName, ownerName, email, phone, password, plan = 'trial', products = [], startDate, endDate },
    actor,
    reqMeta = {}
  ) {
    const existing = await User.findOne({ email: email.toLowerCase() });
    if (existing) throw Errors.Conflict('A user with this email already exists');

    const session = await mongoose.startSession();
    session.startTransaction();
    try {
      const [client] = await Client.create([{ name: clientName, isActive: true }], { session });
      // Manager-assigned plan + explicit products, inserted atomically with the client.
      await subscriptionService.createForManager(
        client._id, { plan, products, startDate, endDate }, actor, { session }
      );

      const passwordHash = await bcrypt.hash(password, SALT_ROUNDS);
      const [owner] = await User.create(
        [
          {
            name: ownerName,
            email: email.toLowerCase(),
            phone,
            passwordHash,
            role: 'CLIENT_OWNER',
            clientId: client._id,
            isActive: true,
          },
        ],
        { session }
      );

      // Required audit: same transaction, so a failed audit rolls back client+subscription+owner.
      await auditRequired({
        clientId: client._id,
        userId: actor._id,
        action: 'CLIENT_CREATED',
        resource: 'Client',
        resourceId: String(client._id),
        description: `Provisioned client "${clientName}" with owner ${email}`,
        metadata: { plan, products, ownerUserId: String(owner._id) },
        ipAddress: reqMeta.ip,
        userAgent: reqMeta.userAgent,
      }, { session });

      await session.commitTransaction();

      return {
        client: { id: client._id, name: client.name, isActive: client.isActive },
        owner: {
          id: owner._id,
          name: owner.name,
          email: owner.email,
          phone: owner.phone,
          role: owner.role,
        },
        // password / passwordHash intentionally omitted
      };
    } catch (err) {
      await session.abortTransaction();
      throw err;
    } finally {
      session.endSession();
    }
  },

  /**
   * Sole ongoing Manager mutation of plan/products/dates. Subscription save and the
   * required audit record share one transaction; audit failure rolls the change back.
   */
  async updateClientSubscription(clientId, patch, actor, reqMeta = {}) {
    if (!mongoose.isValidObjectId(clientId)) throw Errors.NotFound('Client not found');
    const client = await Client.findById(clientId).select('_id name').lean();
    if (!client) throw Errors.NotFound('Client not found');

    const session = await mongoose.startSession();
    try {
      let result;
      await session.withTransaction(async () => {
        result = await subscriptionService.updateByManager(client._id, patch, actor, { session });
        await auditRequired({
          clientId: client._id,
          userId: actor._id,
          action: 'SUBSCRIPTION_UPDATED_BY_MANAGER',
          resource: 'Subscription',
          resourceId: result.subscription.id,
          description: `Manager updated subscription for client "${client.name}"`,
          metadata: { before: result.before, after: result.after },
          ipAddress: reqMeta.ip,
          userAgent: reqMeta.userAgent,
        }, { session });
      });
      return result.subscription;
    } finally {
      await session.endSession();
    }
  },

  /**
   * Read-only entitlement inventory. Includes active+inactive clients and clients with no
   * subscription. Products come ONLY from Subscription.products; integration state is not used.
   */
  async entitlementInventory({ page = 1, limit = 50, product, isActive } = {}) {
    const p = Math.max(1, parseInt(page, 10) || 1);
    const l = Math.min(100, Math.max(1, parseInt(limit, 10) || 50));
    const filter = {};
    if (isActive === 'true' || isActive === true) filter.isActive = true;
    if (isActive === 'false' || isActive === false) filter.isActive = false;

    const pipeline = [
      { $match: filter },
      { $lookup: { from: 'subscriptions', localField: '_id', foreignField: 'clientId', as: 'sub' } },
      { $addFields: { sub: { $first: '$sub' } } },
    ];
    if (product === 'NONE') pipeline.push({ $match: { $or: [{ sub: null }, { 'sub.products.0': { $exists: false } }] } });
    else if (product === 'BOTH') pipeline.push({ $match: { 'sub.products': { $all: ['BANKING', 'MPESA'] } } });
    else if (product === 'BANKING' || product === 'MPESA') pipeline.push({ $match: { 'sub.products': product } });
    pipeline.push({ $sort: { createdAt: -1, _id: 1 } });

    const [rows, countRow] = await Promise.all([
      Client.aggregate([...pipeline, { $skip: (p - 1) * l }, { $limit: l }]),
      Client.aggregate([...pipeline, { $count: 'total' }]),
    ]);
    return {
      items: rows.map((c) => ({
        clientId: String(c._id),
        name: c.name,
        isActive: c.isActive,
        hasSubscription: !!c.sub,
        plan: c.sub?.plan ?? null,
        status: c.sub?.status ?? null,
        products: c.sub?.products ?? [],
        assignedByUserId: c.sub?.assignedByUserId ? String(c.sub.assignedByUserId) : null,
        lastChangedByUserId: c.sub?.lastChangedByUserId ? String(c.sub.lastChangedByUserId) : null,
        updatedAt: c.sub?.updatedAt ?? null,
      })),
      page: p,
      limit: l,
      total: countRow[0]?.total ?? 0,
    };
  },

  async updateClient(clientId, { name }, actor, reqMeta = {}) {
    const client = await Client.findByIdAndUpdate(
      clientId,
      { ...(name !== undefined ? { name } : {}) },
      { new: true }
    );
    if (!client) throw Errors.NotFound('Client not found');

    await audit({
      clientId: client._id,
      userId: actor._id,
      action: 'CLIENT_UPDATED',
      resource: 'Client',
      resourceId: client._id,
      description: `Updated client name to "${client.name}"`,
      ipAddress: reqMeta.ip,
      userAgent: reqMeta.userAgent,
    });

    return client;
  },

  async activateClient(clientId, actor, reqMeta = {}) {
    const client = await Client.findByIdAndUpdate(clientId, { isActive: true }, { new: true });
    if (!client) throw Errors.NotFound('Client not found');

    await audit({
      clientId: client._id,
      userId: actor._id,
      action: 'CLIENT_ACTIVATED',
      resource: 'Client',
      resourceId: client._id,
      ipAddress: reqMeta.ip,
      userAgent: reqMeta.userAgent,
    });
    return client;
  },

  async deactivateClient(clientId, actor, reqMeta = {}) {
    const client = await Client.findByIdAndUpdate(clientId, { isActive: false }, { new: true });
    if (!client) throw Errors.NotFound('Client not found');

    await audit({
      clientId: client._id,
      userId: actor._id,
      action: 'CLIENT_DEACTIVATED',
      resource: 'Client',
      resourceId: client._id,
      ipAddress: reqMeta.ip,
      userAgent: reqMeta.userAgent,
    });
    return client;
  },

  // ── Platform users (cross-client, safe fields only) ─────────────────
  async listUsers({ page = 1, limit = 50, role, clientId, isActive } = {}) {
    const filter = {};
    if (role) filter.role = role;
    if (clientId) filter.clientId = clientId;
    if (typeof isActive === 'boolean') filter.isActive = isActive;

    const skip = (Math.max(1, page) - 1) * Math.min(100, Math.max(1, limit));
    const lim = Math.min(100, Math.max(1, limit));

    const [items, total] = await Promise.all([
      User.find(filter)
        .select('name email phone role clientId isActive lastLoginAt createdAt')
        .populate('clientId', 'name isActive')
        .sort({ createdAt: -1 })
        .skip(skip)
        .limit(lim)
        .lean(),
      User.countDocuments(filter),
    ]);

    return {
      items: items.map((u) => ({
        id: u._id,
        name: u.name,
        email: u.email,
        phone: u.phone,
        role: u.role,
        isActive: u.isActive,
        lastLoginAt: u.lastLoginAt,
        createdAt: u.createdAt,
        client: u.clientId
          ? { id: u.clientId._id, name: u.clientId.name, isActive: u.clientId.isActive }
          : null,
      })),
      total,
      page: Math.max(1, page),
      limit: lim,
    };
  },

  // ── Platform audit ──────────────────────────────────────────────────
  /**
   * Read-only Superadmin audit view. Filters: clientId, actor (userId), action (comma list),
   * resource, resourceId, from/to. Returns a safe shape with redacted metadata.
   */
  async listAudit(q = {}) {
    const { page, limit, skip } = pageParams(q);
    const filter = {};
    const bad = (v) => v != null && !mongoose.isValidObjectId(v);
    if (bad(q.clientId) || bad(q.userId)) return { items: [], total: 0, page, limit };
    if (q.clientId) filter.clientId = q.clientId;
    if (q.userId) filter.userId = q.userId;
    if (q.action) filter.action = { $in: String(q.action).split(',').map((x) => x.trim()).filter(Boolean).slice(0, 20) };
    if (q.resource) filter.resource = String(q.resource);
    if (q.resourceId) filter.resourceId = String(q.resourceId);
    if (q.from || q.to) {
      filter.createdAt = {};
      const from = q.from ? new Date(q.from) : null;
      const to = q.to ? new Date(q.to) : null;
      if (from && !Number.isNaN(from.getTime())) filter.createdAt.$gte = from;
      if (to && !Number.isNaN(to.getTime())) filter.createdAt.$lte = to;
      if (!Object.keys(filter.createdAt).length) delete filter.createdAt;
    }

    const [rows, total] = await Promise.all([
      AuditLog.find(filter).sort({ createdAt: -1, _id: -1 }).skip(skip).limit(limit)
        .populate('userId', 'name email role').populate('clientId', 'name isActive').lean(),
      AuditLog.countDocuments(filter),
    ]);
    return { items: rows.map(toSafeAudit), total, page, limit };
  },

  /** Platform-wide read-only Banking / M-PESA integration monitoring. */
  listBankingIntegrations: (q) => listBankingIntegrations(q),
  listMpesaIntegrations: (q) => listMpesaIntegrations(q),

  /**
   * Read-only diagnostics for ONE client (works for inactive clients). Every query is scoped
   * to clientId; no impersonation, no mutation, no change to ordinary client access rules.
   */
  async clientDiagnostics(clientId) {
    const detail = await this.getClient(clientId);
    const [banking, mpesa, recentAudit, jobs] = await Promise.all([
      checkEntitlement(clientId, 'BANKING'),
      checkEntitlement(clientId, 'MPESA'),
      AuditLog.find({ clientId }).sort({ createdAt: -1, _id: -1 }).limit(25)
        .populate('userId', 'name email role').lean(),
      getBackgroundJobStatus(),
    ]);
    const key = String(clientId);
    return {
      client: detail,
      // Why ordinary customer operations are (not) available right now.
      operationalAccess: {
        clientActive: detail.isActive === true,
        ordinaryOperationsBlocked: detail.isActive !== true,
        entitlement: { BANKING: banking, MPESA: mpesa },
      },
      recentAudit: recentAudit.map(toSafeAudit),
      jobOutcomes: jobs.jobs.map((j) => ({
        name: j.name,
        lastRunAt: j.lastRunAt,
        lastOutcome: j.lastOutcome
          ? {
              outcome: j.lastOutcome.outcome,
              finishedAt: j.lastOutcome.finishedAt || null,
              // Per-client counts only where the job reports them (e.g. bankSync).
              forThisClient: (j.lastOutcome.clients || []).find((c) => c.clientId === key) || null,
            }
          : null,
      })),
    };
  },

  // ── Subscriptions (read-only what the model supports) ───────────────
  async listSubscriptions({ page = 1, limit = 50, status } = {}) {
    const filter = {};
    if (status) filter.status = status;
    const skip = (Math.max(1, page) - 1) * Math.min(100, Math.max(1, limit));
    const lim = Math.min(100, Math.max(1, limit));

    const [items, total] = await Promise.all([
      Subscription.find(filter)
        .populate('clientId', 'name isActive')
        .sort({ createdAt: -1 })
        .skip(skip)
        .limit(lim)
        .lean(),
      Subscription.countDocuments(filter),
    ]);

    return { items, total, page: Math.max(1, page), limit: lim };
  },

  // ── System health (safe, verified) ──────────────────────────────────
  async systemHealth() {
    return getPlatformHealth();
  },
};
