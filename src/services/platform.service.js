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
import { audit } from './audit.service.js';
import { getBackgroundJobStatus } from '../jobs/scheduler.js';

const SALT_ROUNDS = 12;

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
    };
  },

  // ── Clients ─────────────────────────────────────────────────────────
  async listClients({ page = 1, limit = 50, isActive } = {}) {
    const filter = {};
    if (typeof isActive === 'boolean') filter.isActive = isActive;
    const skip = (Math.max(1, page) - 1) * Math.min(100, Math.max(1, limit));
    const lim = Math.min(100, Math.max(1, limit));

    const [items, total] = await Promise.all([
      Client.find(filter).sort({ createdAt: -1 }).skip(skip).limit(lim).lean(),
      Client.countDocuments(filter),
    ]);

    // Attach lightweight counts + owner email without N+1 explosion
    const clientIds = items.map((c) => c._id);
    const [owners, estateCounts, houseCounts] = await Promise.all([
      User.find({ clientId: { $in: clientIds }, role: 'CLIENT_OWNER' })
        .select('clientId name email phone isActive')
        .lean(),
      Estate.aggregate([
        { $match: { clientId: { $in: clientIds } } },
        { $group: { _id: '$clientId', count: { $sum: 1 } } },
      ]),
      House.aggregate([
        { $match: { clientId: { $in: clientIds } } },
        { $group: { _id: '$clientId', count: { $sum: 1 } } },
      ]),
    ]);

    const ownerByClient = new Map(owners.map((o) => [String(o.clientId), o]));
    const estatesByClient = new Map(estateCounts.map((e) => [String(e._id), e.count]));
    const housesByClient = new Map(houseCounts.map((h) => [String(h._id), h.count]));

    return {
      items: items.map((c) => ({
        ...c,
        owner: ownerByClient.get(String(c._id)) || null,
        estateCount: estatesByClient.get(String(c._id)) || 0,
        houseCount: housesByClient.get(String(c._id)) || 0,
      })),
      total,
      page: Math.max(1, page),
      limit: lim,
    };
  },

  async getClient(clientId) {
    const client = await Client.findById(clientId).lean();
    if (!client) throw Errors.NotFound('Client not found');

    const [owner, subscription, estateCount, houseCount, tenantCount, staffCount] =
      await Promise.all([
        User.findOne({ clientId, role: 'CLIENT_OWNER' }).select('-passwordHash').lean(),
        Subscription.findOne({ clientId }).lean(),
        Estate.countDocuments({ clientId }),
        House.countDocuments({ clientId }),
        Tenant.countDocuments({ clientId, status: 'active' }),
        User.countDocuments({
          clientId,
          role: { $in: ['CLIENT_OWNER', 'CLIENT_ADMIN', 'STAFF'] },
        }),
      ]);

    return {
      ...client,
      owner: owner || null,
      subscription: subscription || null,
      estateCount,
      houseCount,
      activeTenantCount: tenantCount,
      staffCount,
    };
  },

  /**
   * Atomic client + owner + subscription provisioning.
   * Does not create SUPER_ADMIN users. Password is never returned.
   */
  async provisionClient(
    { clientName, ownerName, email, phone, password, plan = 'trial' },
    actor,
    reqMeta = {}
  ) {
    const existing = await User.findOne({ email: email.toLowerCase() });
    if (existing) throw Errors.Conflict('A user with this email already exists');

    const session = await mongoose.startSession();
    session.startTransaction();
    try {
      const [client] = await Client.create([{ name: clientName, isActive: true }], { session });
      // Client-scoped subscription (unique on clientId). Idempotent create
      // avoids colliding with any residual documents if a prior attempt
      // partially committed outside a transaction on older deploys.
      await subscriptionService.ensureForClient(client._id, { plan: plan || 'trial', status: 'active' }, { session });

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

      await session.commitTransaction();

      await audit({
        clientId: client._id,
        userId: actor._id,
        action: 'CLIENT_CREATED',
        resource: 'Client',
        resourceId: client._id,
        description: `Provisioned client "${clientName}" with owner ${email}`,
        metadata: { plan, ownerUserId: String(owner._id) },
        ipAddress: reqMeta.ip,
        userAgent: reqMeta.userAgent,
      });

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
  async listAudit({ page = 1, limit = 50, action, clientId } = {}) {
    const filter = {};
    if (action) filter.action = action;
    if (clientId) filter.clientId = clientId;

    const skip = (Math.max(1, page) - 1) * Math.min(100, Math.max(1, limit));
    const lim = Math.min(100, Math.max(1, limit));

    const [items, total] = await Promise.all([
      AuditLog.find(filter)
        .sort({ createdAt: -1 })
        .skip(skip)
        .limit(lim)
        .populate('userId', 'name email role')
        .lean(),
      AuditLog.countDocuments(filter),
    ]);

    return { items, total, page: Math.max(1, page), limit: lim };
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
    const mongoReady = isDatabaseReady();
    const redisResult = await checkRedisHealth(400);

    const bankConfigured = Boolean(
      env.COOP_CLIENT_ID && env.COOP_CLIENT_SECRET && env.COOP_USERNAME && env.COOP_PASSWORD
    );
    const smsConfigured = Boolean(env.CELCOM_PARTNER_ID && env.CELCOM_API_KEY);

    return {
      application: 'healthy',
      mongo: mongoReady ? 'healthy' : 'unhealthy',
      redis: redisResult.status,
      redisLatencyMs: redisResult.latencyMs ?? null,
      bankProvider: {
        name: 'COOP',
        configured: bankConfigured,
        implemented: true,
        // Live sandbox verification is separate from configuration
        liveVerified: false,
      },
      smsProvider: {
        name: 'CELCOM',
        configured: smsConfigured,
        implemented: true,
        liveVerified: false,
      },
      otherBankProviders: [
        { name: 'KCB', implemented: false },
        { name: 'EQUITY', implemented: false },
        { name: 'NCBA', implemented: false },
      ],
      backgroundJobs: await getBackgroundJobStatus(),
    };
  },
};
