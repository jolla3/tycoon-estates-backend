// src/services/ledger.service.js
//
// Financial source of truth. All account balances for tenant/house must
// be derived from Ledger running balances (or recomputed from Ledger rows).
//
// RentCharge.amountPaidCents / balanceCents remain operational caches for
// allocation and billing UI — they are NOT the authoritative account balance.

import { Ledger } from '../models/Ledger.js';
import { RentCharge } from '../models/RentCharge.js';
import { money } from '../utils/money.js';
import { estateFilterClause } from '../utils/estateFilter.js';

/**
 * Latest running balance for a house (amount owed). Falls back to sum of
 * open RentCharge balances only when no ledger rows exist yet (migration).
 */
async function currentBalanceForHouse(clientId, houseId, { session } = {}) {
  const last = await Ledger.findOne({ clientId, houseId })
    .sort({ createdAt: -1, _id: -1 })
    .session(session || null)
    .lean();
  if (last) return last.runningBalanceCents;

  const open = await RentCharge.find({
    clientId,
    houseId,
    status: { $in: ['UNPAID', 'PARTIAL'] },
  })
    .session(session || null)
    .select('balanceCents')
    .lean();
  return open.reduce((s, c) => s + Math.max(c.balanceCents || 0, 0), 0);
}

/**
 * Post a ledger entry. Idempotent when referenceType + referenceId + entryType
 * already exist — returns the existing row without creating a second balance.
 *
 * amountCents: signed. For PAYMENT use positive (credit reduces debt).
 */
async function postEntry(
  {
    clientId,
    estateId,
    houseId,
    tenantId = null,
    entryType,
    amountCents,
    referenceType = null,
    referenceId = null,
    description = '',
    period = null,
  },
  { session } = {}
) {
  const amount = Math.trunc(Number(amountCents));
  if (!Number.isFinite(amount) || amount === 0) {
    throw new Error('ledger amountCents must be a non-zero integer');
  }

  if (referenceType && referenceId) {
    const existing = await Ledger.findOne({
      clientId,
      referenceType,
      referenceId,
      entryType,
    })
      .session(session || null)
      .lean();
    if (existing) {
      return { entry: existing, reused: true };
    }
  }

  const prior = await currentBalanceForHouse(clientId, houseId, { session });
  // Credit (positive amount) reduces amount owed; debit (negative) increases it.
  const runningBalanceCents = money.subtract(prior, amount);

  try {
    const [entry] = await Ledger.create(
      [
        {
          clientId,
          estateId,
          houseId,
          tenantId: tenantId || null,
          entryType,
          amountCents: amount,
          runningBalanceCents,
          referenceType: referenceType || null,
          referenceId: referenceId || null,
          description: description || '',
          period: period || null,
        },
      ],
      session ? { session } : undefined
    );
    return { entry, reused: false };
  } catch (err) {
    // Unique index race: another worker posted the same reference
    if (err?.code === 11000 && referenceType && referenceId) {
      const existing = await Ledger.findOne({
        clientId,
        referenceType,
        referenceId,
        entryType,
      })
        .session(session || null)
        .lean();
      if (existing) return { entry: existing, reused: true };
    }
    throw err;
  }
}

/**
 * Authoritative house account balance (amount owed). Prefer Ledger.
 */
async function balanceForHouse(clientId, houseId, estateFilter = null) {
  const filter = { clientId, houseId, ...estateFilterClause(estateFilter) };
  // estateFilter may not include house ownership — caller must already scope house
  const last = await Ledger.findOne({ clientId, houseId }).sort({ createdAt: -1, _id: -1 }).lean();
  if (last) {
    return {
      balanceCents: last.runningBalanceCents,
      source: 'ledger',
      asOf: last.createdAt,
    };
  }
  const open = await RentCharge.find({
    clientId,
    houseId,
    status: { $in: ['UNPAID', 'PARTIAL'] },
  })
    .select('balanceCents')
    .lean();
  const balanceCents = open.reduce((s, c) => s + Math.max(c.balanceCents || 0, 0), 0);
  return { balanceCents, source: 'rentcharge_fallback', asOf: null };
}

/**
 * Tenant balance = balance of their current house (tenant accounts are house-scoped).
 */
async function balanceForTenant(clientId, tenantId, houseId, estateFilter = null) {
  if (houseId) return balanceForHouse(clientId, houseId, estateFilter);
  const last = await Ledger.findOne({ clientId, tenantId }).sort({ createdAt: -1, _id: -1 }).lean();
  if (last) {
    return {
      balanceCents: last.runningBalanceCents,
      source: 'ledger',
      asOf: last.createdAt,
    };
  }
  return { balanceCents: 0, source: 'empty', asOf: null };
}

async function historyForHouse(clientId, houseId, { limit = 100 } = {}) {
  return Ledger.find({ clientId, houseId }).sort({ createdAt: -1, _id: -1 }).limit(limit).lean();
}

async function historyForTenant(clientId, tenantId, { limit = 100 } = {}) {
  return Ledger.find({ clientId, tenantId }).sort({ createdAt: -1, _id: -1 }).limit(limit).lean();
}

/**
 * Total PAYMENT credits posted to ledger for a scope (actual money received).
 */
async function totalPaymentsReceived(clientId, filterExtra = {}) {
  const rows = await Ledger.find({
    clientId,
    entryType: 'PAYMENT',
    ...filterExtra,
  })
    .select('amountCents')
    .lean();
  return rows.reduce((s, r) => s + Math.max(r.amountCents || 0, 0), 0);
}

export const ledgerService = {
  postEntry,
  currentBalanceForHouse,
  balanceForHouse,
  balanceForTenant,
  historyForHouse,
  historyForTenant,
  totalPaymentsReceived,
};
