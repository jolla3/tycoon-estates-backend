// src/services/platformIntegrations.service.js
//
// Superadmin V2 — read-only, platform-wide Banking / M-PESA visibility.
//
// Rules:
//  * Reads BankConnection / BankAccount / MpesaMerchantProfile / G5 ingestion evidence only.
//  * Every record keeps its client identity. Nothing here mutates anything.
//  * Only stored enums/fields are reported. "Operational" is never inferred from the mere
//    existence of a profile/connection, nor from OAuth success. Product ENTITLEMENT is
//    Subscription.products and is deliberately not derived (or re-derived) from this module.
//  * Never exposes credentialsRef, encrypted/hashed account data, tokens, or raw payloads.
import mongoose from 'mongoose';
import { Client } from '../models/Client.js';
import { User } from '../models/User.js';
import { Subscription } from '../models/Subscription.js';
import { BankConnection } from '../models/BankConnection.js';
import { BankAccount } from '../models/BankAccount.js';
import { MpesaMerchantProfile } from '../models/MpesaMerchantProfile.js';
import { MpesaIngestionEvent } from '../models/MpesaIngestionEvent.js';
import { MpesaMerchantProfileEstate } from '../models/MpesaMerchantProfileEstate.js';
import { getCallbackConfig } from './mpesa/darajaCallbackConfig.service.js';
import { PULL_REGISTRATION_ELIGIBILITY } from './mpesa/daraja.constants.js';
import { c2bReadinessBlockers, pullAdvisories, lifecycleAvailability } from './mpesa/mpesaReadiness.js';

const oid = (v) => new mongoose.Types.ObjectId(String(v));
export const escapeRegex = (s) => String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

export function pageParams({ page, limit }, maxLimit = 100, defLimit = 50) {
  const p = Math.max(1, parseInt(page, 10) || 1);
  const l = Math.min(maxLimit, Math.max(1, parseInt(limit, 10) || defLimit));
  return { page: p, limit: l, skip: (p - 1) * l };
}

// ── Per-client summaries (batched: one aggregate per collection per call) ────

/** Banking summary keyed by clientId string. */
export async function bankingSummaryByClient(clientIds) {
  const ids = clientIds.map(oid);
  const [conns, accts] = await Promise.all([
    BankConnection.aggregate([
      { $match: { clientId: { $in: ids } } },
      { $group: {
        _id: { clientId: '$clientId', provider: '$provider', status: '$status' },
        count: { $sum: 1 },
        lastAuthAt: { $max: '$authMeta.lastAuthAt' },
      } },
    ]),
    BankAccount.aggregate([
      { $match: { clientId: { $in: ids } } },
      { $group: {
        _id: { clientId: '$clientId', provider: '$provider', connectionStatus: '$connectionStatus', validationStatus: '$validationStatus' },
        count: { $sum: 1 },
        poll: { $sum: { $cond: ['$entitlements.poll', 1, 0] } },
        statement: { $sum: { $cond: ['$entitlements.statement', 1, 0] } },
        balance: { $sum: { $cond: ['$entitlements.balance', 1, 0] } },
        webhookIngest: { $sum: { $cond: ['$entitlements.webhookIngest', 1, 0] } },
        lastAttemptAt: { $max: '$sync.lastAttemptAt' },
        lastSuccessAt: { $max: '$sync.lastSuccessAt' },
      } },
    ]),
  ]);

  const out = new Map();
  const slot = (cid) => {
    if (!out.has(cid)) {
      out.set(cid, {
        connectionCount: 0, providers: [], connectionStatuses: {},
        accountCount: 0, accountConnectionStatuses: {}, validationStatuses: {},
        capabilities: { poll: 0, statement: 0, balance: 0, webhookIngest: 0 },
        lastSyncAttemptAt: null, lastSyncSuccessAt: null,
      });
    }
    return out.get(cid);
  };
  const bump = (o, k, n) => { o[k] = (o[k] || 0) + n; };
  const later = (a, b) => (!a ? b : !b ? a : (a > b ? a : b));

  for (const r of conns) {
    const s = slot(String(r._id.clientId));
    s.connectionCount += r.count;
    if (!s.providers.includes(r._id.provider)) s.providers.push(r._id.provider);
    bump(s.connectionStatuses, r._id.status, r.count);
  }
  for (const r of accts) {
    const s = slot(String(r._id.clientId));
    s.accountCount += r.count;
    if (!s.providers.includes(r._id.provider)) s.providers.push(r._id.provider);
    bump(s.accountConnectionStatuses, r._id.connectionStatus, r.count);
    bump(s.validationStatuses, r._id.validationStatus, r.count);
    for (const k of Object.keys(s.capabilities)) s.capabilities[k] += r[k];
    s.lastSyncAttemptAt = later(s.lastSyncAttemptAt, r.lastAttemptAt);
    s.lastSyncSuccessAt = later(s.lastSyncSuccessAt, r.lastSuccessAt);
  }
  return out;
}

// Allowlisted merchant view. Never includes the Pull nominated number (only its mask), encrypted
// material, provider credentials or raw provider bodies.
export function safeMerchantProfile(p, evidence, mappings) {
  // Mappings are required so every response carries an authoritative lifecycleAvailability; the
  // UI never has to guess. Callers must load them (see mappingsByProfile).
  if (!Array.isArray(mappings)) throw new Error('safeMerchantProfile requires the profile estate mappings');
  const ctx = { activeEstateCount: mappings.filter((m) => m.status === 'ACTIVE').length, config: getCallbackConfig() };
  const reg = (r) => (r ? {
    environment: r.environment || null, configId: r.configId || null, configVersion: r.configVersion || null,
    attemptedAt: r.attemptedAt || null, succeededAt: r.succeededAt || null,
  } : null);
  return {
    id: String(p._id),
    clientId: String(p.clientId),
    estateId: p.estateId ? String(p.estateId) : null, // DEPRECATED legacy field; not authoritative
    displayName: p.displayName || null,
    merchantType: p.merchantType,
    businessShortCode: p.businessShortCode,
    operationalState: p.operationalState,
    callbackCapability: p.callbackCapability,
    pullCapability: p.pullCapability,
    c2bRegistrationState: p.c2bRegistrationState,
    pullRegistrationState: p.pullRegistrationState,
    c2bRegistration: reg(p.c2bRegistration),
    pullRegistration: reg(p.pullRegistration),
    lifecycleRevision: p.lifecycleRevision ?? 0,
    lifecycle: {
      activatedAt: p.lifecycle?.activatedAt || null,
      suspendedAt: p.lifecycle?.suspendedAt || null,
      suspensionReason: p.lifecycle?.suspensionReason || null,
      resumedAt: p.lifecycle?.resumedAt || null,
    },
    // C2B/callback readiness and Pull are reported separately; Pull never blocks C2B.
    readinessBlockers: c2bReadinessBlockers(p, ctx),
    pullAdvisories: pullAdvisories(p),
    lifecycleAvailability: lifecycleAvailability(p, ctx),
    pullNominatedNumber: { captured: Boolean(p.pullNominatedMsisdnMasked), masked: p.pullNominatedMsisdnMasked || null },
    lastPullRegisteredAt: p.lastPullRegisteredAt || null,
    // Registration is blocked until provider evidence exists for this merchant type (fail closed).
    pullRegistrationEligible: Boolean(PULL_REGISTRATION_ELIGIBILITY[p.merchantType]?.verified),
    createdAt: p.createdAt,
    updatedAt: p.updatedAt,
    estates: mappings.map((m) => ({ estateId: String(m.estateId), status: m.status })),
    ...(evidence !== undefined ? { ingestionEvidence: evidence } : {}),
  };
}

/** Estate mappings for many profiles in one query, keyed by profile id string. */
export async function mappingsByProfile(profileIds) {
  const out = new Map(profileIds.map((id) => [String(id), []]));
  if (!profileIds.length) return out;
  const rows = await MpesaMerchantProfileEstate.find({ merchantProfileId: { $in: profileIds.map(oid) } }).lean();
  for (const m of rows) out.get(String(m.merchantProfileId))?.push(m);
  return out;
}

/** Last received G5 ingestion event per merchant profile (safe: timestamps/state/channel only). */
async function ingestionEvidence(profileIds) {
  if (!profileIds.length) return new Map();
  const rows = await MpesaIngestionEvent.aggregate([
    { $match: { merchantProfileId: { $in: profileIds.map(oid) } } },
    { $sort: { receivedAt: -1 } },
    { $group: {
      _id: { p: '$merchantProfileId', ch: '$sourceChannel' },
      lastReceivedAt: { $first: '$receivedAt' },
      lastState: { $first: '$state' },
      total: { $sum: 1 },
    } },
  ]);
  const m = new Map();
  for (const r of rows) {
    const k = String(r._id.p);
    if (!m.has(k)) m.set(k, {});
    m.get(k)[r._id.ch] = { lastReceivedAt: r.lastReceivedAt, lastState: r.lastState, total: r.total };
  }
  return m;
}

/** M-PESA summary keyed by clientId string. Profiles are included safely. */
export async function mpesaSummaryByClient(clientIds, { includeProfiles = false } = {}) {
  const profiles = await MpesaMerchantProfile.find({ clientId: { $in: clientIds.map(oid) } })
    .sort({ createdAt: 1, _id: 1 }).lean();
  const ids = profiles.map((p) => p._id);
  const [evidence, mappings] = includeProfiles
    ? await Promise.all([ingestionEvidence(ids), mappingsByProfile(ids)])
    : [null, null];
  const out = new Map();
  for (const p of profiles) {
    const k = String(p.clientId);
    if (!out.has(k)) {
      out.set(k, { profileCount: 0, operationalStates: {}, callbackCapabilities: {}, pullCapabilities: {}, profiles: [] });
    }
    const s = out.get(k);
    s.profileCount += 1;
    s.operationalStates[p.operationalState] = (s.operationalStates[p.operationalState] || 0) + 1;
    s.callbackCapabilities[p.callbackCapability] = (s.callbackCapabilities[p.callbackCapability] || 0) + 1;
    s.pullCapabilities[p.pullCapability] = (s.pullCapabilities[p.pullCapability] || 0) + 1;
    if (includeProfiles) s.profiles.push(safeMerchantProfile(p, evidence.get(String(p._id)) || {}, mappings.get(String(p._id)) || []));
  }
  if (!includeProfiles) for (const s of out.values()) delete s.profiles;
  return out;
}

export const emptyBanking = () => ({
  connectionCount: 0, providers: [], connectionStatuses: {}, accountCount: 0,
  accountConnectionStatuses: {}, validationStatuses: {},
  capabilities: { poll: 0, statement: 0, balance: 0, webhookIngest: 0 },
  lastSyncAttemptAt: null, lastSyncSuccessAt: null,
});
export const emptyMpesa = (withProfiles) => ({
  profileCount: 0, operationalStates: {}, callbackCapabilities: {}, pullCapabilities: {},
  ...(withProfiles ? { profiles: [] } : {}),
});

// ── Client directory filter resolution (set algebra over client ids) ────────

/**
 * Builds a Client `$and` filter. Each integration/subscription criterion resolves to a set of
 * client ids via a single distinct query; criteria are intersected. No N+1.
 */
export async function buildClientDirectoryFilter(q = {}) {
  const and = [];
  const ids = async (promise) => (await promise).map(String);
  const inSet = (arr) => ({ _id: { $in: arr.map(oid) } });

  if (q.isActive === 'true' || q.isActive === true) and.push({ isActive: true });
  if (q.isActive === 'false' || q.isActive === false) and.push({ isActive: false });

  if (q.search) {
    const rx = new RegExp(escapeRegex(String(q.search).slice(0, 100)), 'i');
    const ownerClientIds = await ids(User.distinct('clientId', {
      role: 'CLIENT_OWNER', $or: [{ name: rx }, { email: rx }],
    }));
    and.push({ $or: [{ name: rx }, { _id: { $in: ownerClientIds.map(oid) } }] });
  }

  if (q.product) {
    if (q.product === 'NONE') {
      const withProducts = await ids(Subscription.distinct('clientId', { 'products.0': { $exists: true } }));
      and.push({ _id: { $nin: withProducts.map(oid) } });
    } else if (q.product === 'BOTH') {
      and.push(inSet(await ids(Subscription.distinct('clientId', { products: { $all: ['BANKING', 'MPESA'] } }))));
    } else if (['BANKING', 'MPESA'].includes(q.product)) {
      and.push(inSet(await ids(Subscription.distinct('clientId', { products: q.product }))));
    }
  }
  if (q.plan || q.subscriptionStatus) {
    const f = {};
    if (q.plan) f.plan = String(q.plan);
    if (q.subscriptionStatus) f.status = String(q.subscriptionStatus);
    and.push(inSet(await ids(Subscription.distinct('clientId', f))));
  }
  if (q.hasSubscription === 'false') {
    and.push({ _id: { $nin: await Subscription.distinct('clientId') } });
  } else if (q.hasSubscription === 'true') {
    and.push(inSet(await ids(Subscription.distinct('clientId'))));
  }

  const connF = {};
  if (q.bankProvider) connF.provider = String(q.bankProvider);
  if (q.bankConnectionStatus) connF.status = String(q.bankConnectionStatus);
  if (Object.keys(connF).length) and.push(inSet(await ids(BankConnection.distinct('clientId', connF))));

  const acctF = {};
  if (q.bankAccountConnectionStatus) acctF.connectionStatus = String(q.bankAccountConnectionStatus);
  if (q.bankValidationStatus) acctF.validationStatus = String(q.bankValidationStatus);
  if (Object.keys(acctF).length) and.push(inSet(await ids(BankAccount.distinct('clientId', acctF))));

  const mpF = {};
  if (q.mpesaState) mpF.operationalState = String(q.mpesaState);
  if (q.callbackCapability) mpF.callbackCapability = String(q.callbackCapability);
  if (q.pullCapability) mpF.pullCapability = String(q.pullCapability);
  if (q.c2bRegistrationState) mpF.c2bRegistrationState = String(q.c2bRegistrationState);
  if (q.pullRegistrationState) mpF.pullRegistrationState = String(q.pullRegistrationState);
  if (Object.keys(mpF).length) and.push(inSet(await ids(MpesaMerchantProfile.distinct('clientId', mpF))));

  return and.length ? { $and: and } : {};
}

// ── Cross-client monitoring lists ────────────────────────────────────────────

async function clientIdentity(clientIds) {
  const rows = await Client.find({ _id: { $in: clientIds.map(oid) } }).select('name isActive').lean();
  return new Map(rows.map((c) => [String(c._id), { clientId: String(c._id), clientName: c.name, clientIsActive: c.isActive }]));
}

function clientScopeFilter(q, filter) {
  if (q.clientId) {
    if (!mongoose.isValidObjectId(q.clientId)) return null;
    filter.clientId = oid(q.clientId);
  }
  return filter;
}

/** Platform-wide Banking integrations: one row per BankConnection, with account rollups. */
export async function listBankingIntegrations(q = {}) {
  const { page, limit, skip } = pageParams(q);
  const filter = clientScopeFilter(q, {});
  if (!filter) return { items: [], total: 0, page, limit };
  if (q.provider) filter.provider = String(q.provider);
  if (q.status) filter.status = String(q.status);

  if (q.clientIsActive === 'true' || q.clientIsActive === 'false') {
    const cids = await Client.distinct('_id', { isActive: q.clientIsActive === 'true' });
    filter.clientId = filter.clientId ? { $in: cids.filter((c) => String(c) === String(filter.clientId)) } : { $in: cids };
  }
  if (q.validationStatus || q.accountConnectionStatus) {
    const af = {};
    if (q.validationStatus) af.validationStatus = String(q.validationStatus);
    if (q.accountConnectionStatus) af.connectionStatus = String(q.accountConnectionStatus);
    filter._id = { $in: await BankAccount.distinct('connectionId', af) };
  }

  const [conns, total] = await Promise.all([
    BankConnection.find(filter).sort({ createdAt: -1, _id: 1 }).skip(skip).limit(limit)
      .select('-credentialsRef').lean(),
    BankConnection.countDocuments(filter),
  ]);

  const connIds = conns.map((c) => c._id);
  const accounts = connIds.length ? await BankAccount.aggregate([
    { $match: { connectionId: { $in: connIds } } },
    { $group: {
      _id: { connectionId: '$connectionId', v: '$validationStatus', c: '$connectionStatus' },
      count: { $sum: 1 },
      poll: { $sum: { $cond: ['$entitlements.poll', 1, 0] } },
      statement: { $sum: { $cond: ['$entitlements.statement', 1, 0] } },
      balance: { $sum: { $cond: ['$entitlements.balance', 1, 0] } },
      webhookIngest: { $sum: { $cond: ['$entitlements.webhookIngest', 1, 0] } },
      lastAttemptAt: { $max: '$sync.lastAttemptAt' },
      lastSuccessAt: { $max: '$sync.lastSuccessAt' },
      lastErrorCategory: { $max: '$sync.lastErrorCategory' },
    } },
  ]) : [];

  const byConn = new Map();
  for (const a of accounts) {
    const k = String(a._id.connectionId);
    if (!byConn.has(k)) {
      byConn.set(k, {
        accountCount: 0, validationStatuses: {}, accountConnectionStatuses: {},
        capabilities: { poll: 0, statement: 0, balance: 0, webhookIngest: 0 },
        lastSyncAttemptAt: null, lastSyncSuccessAt: null, lastSyncErrorCategory: null,
      });
    }
    const s = byConn.get(k);
    s.accountCount += a.count;
    s.validationStatuses[a._id.v] = (s.validationStatuses[a._id.v] || 0) + a.count;
    s.accountConnectionStatuses[a._id.c] = (s.accountConnectionStatuses[a._id.c] || 0) + a.count;
    for (const key of Object.keys(s.capabilities)) s.capabilities[key] += a[key];
    if (a.lastAttemptAt && (!s.lastSyncAttemptAt || a.lastAttemptAt > s.lastSyncAttemptAt)) s.lastSyncAttemptAt = a.lastAttemptAt;
    if (a.lastSuccessAt && (!s.lastSyncSuccessAt || a.lastSuccessAt > s.lastSyncSuccessAt)) s.lastSyncSuccessAt = a.lastSuccessAt;
    if (a.lastErrorCategory) s.lastSyncErrorCategory = a.lastErrorCategory;
  }

  const identity = await clientIdentity([...new Set(conns.map((c) => String(c.clientId)))]);
  return {
    items: conns.map((c) => ({
      connectionId: String(c._id),
      ...(identity.get(String(c.clientId)) || { clientId: String(c.clientId) }),
      provider: c.provider,
      displayName: c.displayName || null,
      status: c.status,
      needsReauthorization: c.status === 'reauth_required',
      authEvidence: {
        lastAuthAt: c.authMeta?.lastAuthAt || null,
        tokenExpiresAt: c.authMeta?.tokenExpiresAt || null,
        lastAuthError: c.authMeta?.lastAuthError ? String(c.authMeta.lastAuthError).slice(0, 200) : null,
      },
      accounts: byConn.get(String(c._id)) || {
        accountCount: 0, validationStatuses: {}, accountConnectionStatuses: {},
        capabilities: { poll: 0, statement: 0, balance: 0, webhookIngest: 0 },
        lastSyncAttemptAt: null, lastSyncSuccessAt: null, lastSyncErrorCategory: null,
      },
      createdAt: c.createdAt,
      updatedAt: c.updatedAt,
    })),
    total, page, limit,
  };
}

/**
 * Known C2B blockers derived ONLY from stored states (never from guesses). Pull state is NOT a
 * blocker: Pull is optional and reported separately via pullAdvisories().
 */
export function mpesaBlockers(p, ctx = {}) {
  const b = [];
  if (p.operationalState !== 'ACTIVE') b.push(`OPERATIONAL_STATE_${p.operationalState}`);
  return [...b, ...c2bReadinessBlockers(p, ctx)];
}

/** Platform-wide M-PESA merchant profiles with independent callback/Pull state. */
export async function listMpesaIntegrations(q = {}) {
  const { page, limit, skip } = pageParams(q);
  const filter = clientScopeFilter(q, {});
  if (!filter) return { items: [], total: 0, page, limit };
  if (q.operationalState) filter.operationalState = String(q.operationalState);
  if (q.callbackCapability) filter.callbackCapability = String(q.callbackCapability);
  if (q.pullCapability) filter.pullCapability = String(q.pullCapability);
  if (q.c2bRegistrationState) filter.c2bRegistrationState = String(q.c2bRegistrationState);
  if (q.pullRegistrationState) filter.pullRegistrationState = String(q.pullRegistrationState);
  if (q.clientIsActive === 'true' || q.clientIsActive === 'false') {
    const cids = await Client.distinct('_id', { isActive: q.clientIsActive === 'true' });
    filter.clientId = filter.clientId ? { $in: cids.filter((c) => String(c) === String(filter.clientId)) } : { $in: cids };
  }

  const [profiles, total] = await Promise.all([
    MpesaMerchantProfile.find(filter).sort({ createdAt: -1, _id: 1 }).skip(skip).limit(limit).lean(),
    MpesaMerchantProfile.countDocuments(filter),
  ]);
  const [evidence, identity, mappings] = await Promise.all([
    ingestionEvidence(profiles.map((p) => p._id)),
    clientIdentity([...new Set(profiles.map((p) => String(p.clientId)))]),
    mappingsByProfile(profiles.map((p) => p._id)),
  ]);
  return {
    items: profiles.map((p) => ({
      ...(identity.get(String(p.clientId)) || { clientId: String(p.clientId) }),
      ...safeMerchantProfile(p, evidence.get(String(p._id)) || {}, mappings.get(String(p._id)) || []),
      blockers: mpesaBlockers(p, { activeEstateCount: (mappings.get(String(p._id)) || []).filter((m) => m.status === 'ACTIVE').length, config: getCallbackConfig() }),
    })),
    total, page, limit,
  };
}

// ── Overview distributions ──────────────────────────────────────────────────

const toMap = (rows) => Object.fromEntries(rows.map((r) => [String(r._id), r.count]));

export async function integrationDistributions() {
  const g = (field) => [{ $group: { _id: `$${field}`, count: { $sum: 1 } } }];
  const [connStatus, acctValidation, acctConn, mpState, cb, pull, c2b, pullReg, prodRows, totalClients, subClients] = await Promise.all([
    BankConnection.aggregate(g('status')),
    BankAccount.aggregate(g('validationStatus')),
    BankAccount.aggregate(g('connectionStatus')),
    MpesaMerchantProfile.aggregate(g('operationalState')),
    MpesaMerchantProfile.aggregate(g('callbackCapability')),
    MpesaMerchantProfile.aggregate(g('pullCapability')),
    MpesaMerchantProfile.aggregate(g('c2bRegistrationState')),
    MpesaMerchantProfile.aggregate(g('pullRegistrationState')),
    Subscription.aggregate([{ $group: {
      _id: null,
      banking: { $sum: { $cond: [{ $in: ['BANKING', { $ifNull: ['$products', []] }] }, 1, 0] } },
      mpesa: { $sum: { $cond: [{ $in: ['MPESA', { $ifNull: ['$products', []] }] }, 1, 0] } },
      both: { $sum: { $cond: [{ $and: [{ $in: ['BANKING', { $ifNull: ['$products', []] }] }, { $in: ['MPESA', { $ifNull: ['$products', []] }] }] }, 1, 0] } },
      withSubscription: { $sum: 1 },
    } }]),
    Client.countDocuments({}),
    Subscription.distinct('clientId'),
  ]);
  const p = prodRows[0] || { banking: 0, mpesa: 0, both: 0, withSubscription: 0 };
  const withSub = subClients.length;
  return {
    productAssignments: {
      // Sourced exclusively from Subscription.products.
      banking: p.banking,
      mpesa: p.mpesa,
      both: p.both,
      neither: withSub - (p.banking + p.mpesa - p.both),
      clientsWithoutSubscription: Math.max(0, totalClients - withSub),
    },
    banking: { connectionStatuses: toMap(connStatus), accountValidationStatuses: toMap(acctValidation), accountConnectionStatuses: toMap(acctConn) },
    mpesa: {
      operationalStates: toMap(mpState), callbackCapabilities: toMap(cb), pullCapabilities: toMap(pull),
      c2bRegistrationStates: toMap(c2b), pullRegistrationStates: toMap(pullReg),
    },
  };
}
