/**
 * Versioned all-or-nothing backfill: Payment.allocatedCents ← sum(PaymentAllocation).
 *
 * Safety:
 *  - Full preflight before any write
 *  - Any conflict → exit 1, zero writes
 *  - Apply inside one MongoDB transaction with conditional updates
 *  - Explicit DB allowlist only (no production bypass)
 *
 * Required env:
 *  MONGODB_URI
 *  G3_SAFE_DB_ALLOWLIST  — comma-separated exact database names permitted
 *  G3_MIGRATION_TARGET_DB — must equal connected DB name and appear in allowlist
 *
 * Usage:
 *  G3_SAFE_DB_ALLOWLIST=tycoon_g3_test \
 *  G3_MIGRATION_TARGET_DB=tycoon_g3_test \
 *  MONGODB_URI=mongodb://127.0.0.1:27017/tycoon_g3_test \
 *  node scripts/migrations/20261107_backfill_payment_allocated_cents.js --dry-run|--apply
 */
import mongoose from 'mongoose';
import { Payment } from '../../src/models/Payment.js';
import { PaymentAllocation } from '../../src/models/PaymentAllocation.js';
import { RentCharge } from '../../src/models/RentCharge.js';

const APPLY = process.argv.includes('--apply');

function dbNameFromUri(uri) {
  const u = new URL(uri);
  return (u.pathname || '').replace(/^\//, '').split('?')[0];
}

function parseAllowlist() {
  const raw = process.env.G3_SAFE_DB_ALLOWLIST || '';
  return new Set(
    raw.split(',').map((s) => s.trim()).filter(Boolean)
  );
}

function assertSafeTarget(uri) {
  if (!uri) {
    console.error('MONGODB_URI required');
    process.exit(2);
  }
  let db;
  try {
    db = dbNameFromUri(uri);
  } catch {
    console.error('MONGODB_URI is not a valid URL');
    process.exit(2);
  }
  if (!db) {
    console.error('MONGODB_URI must include a database name');
    process.exit(2);
  }
  if (/prod|production|atlas|estate|live/.test(uri.toLowerCase())) {
    console.error('Refusing: URI matches production-like pattern');
    process.exit(2);
  }
  const allow = parseAllowlist();
  if (allow.size === 0) {
    console.error('Refusing: G3_SAFE_DB_ALLOWLIST must list exact disposable DB names');
    process.exit(2);
  }
  const target = process.env.G3_MIGRATION_TARGET_DB;
  if (!target || target !== db) {
    console.error(
      `Refusing: G3_MIGRATION_TARGET_DB must exactly equal URI database name (env=${JSON.stringify(target)} db=${JSON.stringify(db)})`
    );
    process.exit(2);
  }
  if (!allow.has(db)) {
    console.error(
      `Refusing: database "${db}" is not in G3_SAFE_DB_ALLOWLIST (${[...allow].join(', ')})`
    );
    process.exit(2);
  }
  return db;
}

function isPositiveSafeInt(v) {
  return Number.isInteger(v) && Number.isSafeInteger(v) && v > 0;
}

function sameId(a, b) {
  return a != null && b != null && String(a) === String(b);
}

async function validatePayment(p, session = null) {
  const q = PaymentAllocation.find({ paymentId: p._id });
  if (session) q.session(session);
  const allocations = await q.lean();
  let total = 0;

  if (!p.tenancyId && allocations.some((a) => a.tenancyId)) {
    return { total: 0, conflict: { reason: 'payment_missing_tenancy_with_scoped_allocations' } };
  }

  for (const a of allocations) {
    if (!isPositiveSafeInt(a.amountCents)) {
      return { total: 0, conflict: { reason: 'invalid_allocation_amount', allocationId: String(a._id) } };
    }
    if (!sameId(a.clientId, p.clientId) || !sameId(a.estateId, p.estateId)) {
      return { total: 0, conflict: { reason: 'allocation_client_estate_mismatch', allocationId: String(a._id) } };
    }
    if (p.tenancyId) {
      if (!a.tenancyId || !sameId(a.tenancyId, p.tenancyId)) {
        return { total: 0, conflict: { reason: 'allocation_tenancy_mismatch', allocationId: String(a._id) } };
      }
    } else if (a.tenancyId) {
      return { total: 0, conflict: { reason: 'allocation_has_tenancy_payment_does_not', allocationId: String(a._id) } };
    }

    const cq = RentCharge.findById(a.rentChargeId);
    if (session) cq.session(session);
    const charge = await cq.lean();
    if (!charge) {
      return { total: 0, conflict: { reason: 'missing_rent_charge', allocationId: String(a._id) } };
    }
    if (!sameId(charge.clientId, p.clientId)
      || !sameId(charge.estateId, p.estateId)
      || !sameId(charge.houseId, p.houseId)) {
      return { total: 0, conflict: { reason: 'charge_scope_mismatch', allocationId: String(a._id) } };
    }
    if (p.tenancyId) {
      if (!charge.tenancyId || !sameId(charge.tenancyId, p.tenancyId)) {
        return { total: 0, conflict: { reason: 'charge_tenancy_mismatch', allocationId: String(a._id) } };
      }
    }
    total += a.amountCents;
  }

  if (total > p.amountCents) {
    return { total, conflict: { reason: 'allocation_sum_exceeds_payment', allocatedSum: total, amountCents: p.amountCents } };
  }
  return { total, conflict: null };
}

async function preflight() {
  const payments = await Payment.find({})
    .select('_id clientId estateId houseId tenancyId amountCents allocatedCents')
    .lean();
  const report = { checked: 0, wouldUpdate: 0, alreadyOk: 0, conflicts: [], plan: [] };

  for (const p of payments) {
    report.checked += 1;
    const { total, conflict } = await validatePayment(p);
    if (conflict) {
      report.conflicts.push({ paymentId: String(p._id), ...conflict });
      continue;
    }
    if ((p.allocatedCents || 0) !== total) {
      report.wouldUpdate += 1;
      report.plan.push({
        paymentId: String(p._id),
        from: p.allocatedCents || 0,
        to: total,
        amountCents: p.amountCents,
      });
    } else {
      report.alreadyOk += 1;
    }
  }
  return report;
}

async function applyAllOrNothing(plan) {
  const session = await mongoose.startSession();
  let updated = 0;
  try {
    await session.withTransaction(async () => {
      for (const item of plan) {
        const p = await Payment.findById(item.paymentId).session(session);
        if (!p) throw new Error(`Payment disappeared: ${item.paymentId}`);

        const { total, conflict } = await validatePayment(p, session);
        if (conflict) throw new Error(`Conflict during apply for ${item.paymentId}: ${conflict.reason}`);
        if (total !== item.to) throw new Error(`Plan stale for ${item.paymentId}: expected ${item.to} got ${total}`);
        if ((p.allocatedCents || 0) !== item.from) {
          throw new Error(`Concurrent counter change for ${item.paymentId}: expected ${item.from} got ${p.allocatedCents}`);
        }
        if (total > p.amountCents) throw new Error(`Sum exceeds payment during apply for ${item.paymentId}`);

        const res = await Payment.updateOne(
          { _id: p._id, allocatedCents: item.from, amountCents: p.amountCents },
          { $set: { allocatedCents: total } },
          { session }
        );
        if (res.matchedCount !== 1 || res.modifiedCount !== 1) {
          throw new Error(
            `Conditional update failed for ${item.paymentId} (matched=${res.matchedCount} modified=${res.modifiedCount})`
          );
        }
        updated += 1;
      }
    });
  } finally {
    session.endSession();
  }
  return updated;
}

async function main() {
  const uri = process.env.MONGODB_URI || process.env.MONGO_URI;
  const db = assertSafeTarget(uri);
  await mongoose.connect(uri, {
    autoIndex: false,
    autoCreate: false,
  });
  if (mongoose.connection.name !== db) {
    console.error(`Connected db ${mongoose.connection.name} != expected ${db}`);
    await mongoose.disconnect();
    process.exit(2);
  }

  const pre = await preflight();
  const out = { dryRun: !APPLY, database: db, ...pre, updated: 0 };

  if (pre.conflicts.length) {
    console.log(JSON.stringify({ ...out, plan: undefined }, null, 2));
    await mongoose.disconnect();
    process.exit(1);
  }

  if (APPLY) {
    out.updated = await applyAllOrNothing(pre.plan);
    if (out.updated !== pre.wouldUpdate) {
      console.error(`Updated count ${out.updated} != plan ${pre.wouldUpdate}`);
      await mongoose.disconnect();
      process.exit(1);
    }
  }

  console.log(JSON.stringify({ ...out, plan: APPLY ? undefined : pre.plan }, null, 2));
  await mongoose.disconnect();
}

const isMain = process.argv[1] && process.argv[1].endsWith('20261107_backfill_payment_allocated_cents.js');
if (isMain) {
  main().catch((e) => {
    console.error(e);
    process.exit(1);
  });
}

export { assertSafeTarget, validatePayment, isPositiveSafeInt, dbNameFromUri, parseAllowlist };
