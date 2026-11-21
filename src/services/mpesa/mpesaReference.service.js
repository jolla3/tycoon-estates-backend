// PayBill collection references: issuance, retirement and receipt allocation.
// A reference is routing evidence only. It never proves payment and never bypasses the
// provider-verification, amount/time, fencing, G3 settlement, audit or feature-gate rules.
import mongoose from 'mongoose';
import { MpesaCollectionReference } from '../../models/MpesaCollectionReference.js';
import { MpesaMerchantProfile } from '../../models/MpesaMerchantProfile.js';
import { MpesaTransaction } from '../../models/MpesaTransaction.js';
import { Tenancy } from '../../models/Tenancy.js';
import { auditRequired } from '../audit.service.js';
import { inspectMpesaIndexes } from '../../utils/mpesaIndexReadiness.js';
import { isActiveMapping } from './mpesaMerchantMapping.service.js';
import { MERCHANT_TYPE, ALLOCATION_STATE } from './daraja.constants.js';
import { normalizeCollectionReference, generateCollectionReference } from '../../utils/mpesaCollectionReference.js';
import { Errors, AppError } from '../../utils/errors.js';

const MAX_GENERATION_ATTEMPTS = 6;

/** Fail closed unless the migration-controlled unique indexes are present with the exact shape. */
export async function assertReferenceIndexesReady() {
  const report = await inspectMpesaIndexes();
  if (!report?.gates?.collectionReferences) {
    throw new AppError(
      'MPESA_REFERENCE_INDEXES_NOT_READY',
      'Collection-reference unique indexes are not provisioned; run the G5.4 migration before issuing references',
      503,
    );
  }
}

/**
 * Classify a Mongo duplicate-key error by the index that fired.
 * Returns 'active_tenancy' | 'reference' | 'unknown' | null (not a duplicate-key error).
 */
export function duplicateKeyIndex(err) {
  if (!err || (err.code !== 11000 && err.code !== 11001)) return null;
  const text = `${err.message || ''} ${err.errmsg || ''}`;
  if (text.includes('uniq_mpesa_ref_active_tenancy')) return 'active_tenancy';
  if (text.includes('uniq_mpesa_ref_merchant_reference')) return 'reference';
  const kp = err.keyPattern || err.keyValue || null;
  if (kp && 'tenancyId' in kp) return 'active_tenancy';
  if (kp && 'reference' in kp) return 'reference';
  return 'unknown';
}

/**
 * Resolve a provider BillRefNumber for one PayBill merchant profile.
 * Returns { state: 'ok'|'unallocated', reason, reference }. Unknown, malformed, missing,
 * retired, scope-mismatched or unmapped references are ALWAYS unallocated.
 */
export async function resolveReference({ profile, billRefNumber, session = null }) {
  if (!profile || profile.merchantType !== MERCHANT_TYPE.PAYBILL) {
    return { state: 'unallocated', reason: 'not_paybill_merchant', reference: null };
  }
  const norm = normalizeCollectionReference(billRefNumber);
  if (norm.status === 'missing') return { state: 'unallocated', reason: 'reference_missing', reference: null };
  if (norm.status === 'malformed') return { state: 'unallocated', reason: 'reference_malformed', reference: null };

  const ref = await MpesaCollectionReference.findOne({
    merchantProfileId: profile._id, reference: norm.reference,
  }).session(session);
  if (!ref) return { state: 'unallocated', reason: 'reference_unknown', reference: null };
  // Retired references keep their owner but never auto-allocate; they surface for review.
  if (ref.status !== 'ACTIVE') return { state: 'unallocated', reason: 'reference_retired', reference: ref };
  if (String(ref.clientId) !== String(profile.clientId)) {
    return { state: 'unallocated', reason: 'reference_scope_mismatch', reference: ref };
  }
  const mapped = await isActiveMapping({
    merchantProfileId: profile._id, clientId: profile.clientId, estateId: ref.estateId, session,
  });
  if (!mapped) return { state: 'unallocated', reason: 'estate_mapping_inactive', reference: ref };
  const tenancy = await Tenancy.findOne({ _id: ref.tenancyId, clientId: ref.clientId }).session(session).select('status tenantId estateId').lean();
  if (!tenancy || String(tenancy.tenantId) !== String(ref.tenantId) || String(tenancy.estateId) !== String(ref.estateId)) {
    return { state: 'unallocated', reason: 'tenancy_identity_mismatch', reference: ref };
  }
  if (tenancy.status !== 'ACTIVE') return { state: 'unallocated', reason: 'tenancy_not_active', reference: ref };
  return { state: 'ok', reason: null, reference: ref };
}

/**
 * Persist the allocation decision on the canonical receipt. First allocation wins and is never
 * reassigned (conditional on allocatedEstateId === null). Idempotent for repeat observations.
 */
export async function allocateReceiptByReference(txn, profile, { session = null } = {}) {
  if (txn.allocationState !== ALLOCATION_STATE.UNALLOCATED || txn.allocatedEstateId) {
    return { changed: false, allocationState: txn.allocationState, reason: txn.allocationReason };
  }
  const res = await resolveReference({ profile, billRefNumber: txn.billRefNumber, session });
  if (res.state !== 'ok') {
    await MpesaTransaction.updateOne(
      { _id: txn._id, allocatedEstateId: null },
      { $set: { allocationReason: res.reason, ...(res.reference ? { allocationReferenceId: res.reference._id } : {}) } },
      { session },
    );
    return { changed: false, allocationState: ALLOCATION_STATE.UNALLOCATED, reason: res.reason };
  }
  const r = res.reference;
  const upd = await MpesaTransaction.updateOne(
    { _id: txn._id, allocatedEstateId: null },
    {
      $set: {
        allocationState: ALLOCATION_STATE.BY_REFERENCE, allocationReason: null,
        allocationReferenceId: r._id, allocatedEstateId: r.estateId,
        allocatedTenantId: r.tenantId, allocatedTenancyId: r.tenancyId,
      },
    },
    { session },
  );
  return { changed: upd.modifiedCount === 1, allocationState: ALLOCATION_STATE.BY_REFERENCE, reason: null };
}

export const mpesaReferenceService = {
  toView(r) {
    return {
      id: String(r._id), merchantProfileId: String(r.merchantProfileId), estateId: String(r.estateId),
      tenantId: String(r.tenantId), tenancyId: String(r.tenancyId), reference: r.reference,
      status: r.status, retiredAt: r.retiredAt || null, retiredReason: r.retiredReason || null, createdAt: r.createdAt,
    };
  },

  async list({ clientId, merchantProfileId, query = {} }) {
    const limit = Math.min(Math.max(Number(query.limit) || 25, 1), 100);
    const page = Math.max(Number(query.page) || 1, 1);
    const filter = { clientId, merchantProfileId };
    if (query.status === 'ACTIVE' || query.status === 'RETIRED') filter.status = query.status;
    if (query.estateId && mongoose.isValidObjectId(query.estateId)) filter.estateId = query.estateId;
    const [rows, total] = await Promise.all([
      MpesaCollectionReference.find(filter).sort({ createdAt: -1, _id: -1 }).skip((page - 1) * limit).limit(limit).lean(),
      MpesaCollectionReference.countDocuments(filter),
    ]);
    return { items: rows.map((r) => mpesaReferenceService.toView(r)), total, page, limit };
  },

  /**
   * Issue (or return the existing ACTIVE) reference for one real tenancy on one PayBill.
   *
   * The two unique indexes are the ONLY concurrency authority:
   *   uniq_mpesa_ref_active_tenancy       (merchantProfileId, tenancyId) where ACTIVE
   *   uniq_mpesa_ref_merchant_reference   (merchantProfileId, reference)
   * Issuance fails closed (503) unless inspectMpesaIndexes() reports both present with the exact
   * shape. There is no exists()/findOne pre-check that a race could defeat: we insert, and a
   * duplicate-key error is interpreted by WHICH index fired. Each attempt is its own transaction
   * because a duplicate-key error aborts the surrounding transaction.
   */
  async issue({ clientId, merchantProfileId, tenancyId, actor, reqMeta = {} }) {
    await assertReferenceIndexesReady();
    for (let attempt = 0; attempt < MAX_GENERATION_ATTEMPTS; attempt += 1) {
      const candidate = generateCollectionReference();
      const session = await mongoose.startSession();
      try {
        let row = null;
        await session.withTransaction(async () => {
          row = null;
          const profile = await MpesaMerchantProfile.findOne({ _id: merchantProfileId, clientId }).session(session);
          if (!profile) throw Errors.NotFound('Merchant profile not found');
          if (profile.merchantType !== MERCHANT_TYPE.PAYBILL) throw Errors.InvalidRequest('References are issued only for PAYBILL merchants');
          const tenancy = await Tenancy.findOne({ _id: tenancyId, clientId }).session(session);
          if (!tenancy) throw Errors.NotFound('Tenancy not found');
          if (tenancy.status !== 'ACTIVE') throw Errors.InvalidRequest('References are issued only for an ACTIVE tenancy');
          const mapped = await isActiveMapping({ merchantProfileId: profile._id, clientId, estateId: tenancy.estateId, session });
          if (!mapped) throw Errors.InvalidRequest('Merchant is not actively mapped to the tenancy estate');

          const [created] = await MpesaCollectionReference.create([{
            merchantProfileId, clientId, estateId: tenancy.estateId, tenantId: tenancy.tenantId,
            tenancyId: tenancy._id, reference: candidate, status: 'ACTIVE', createdByUserId: actor?._id || null,
          }], { session });
          row = created;
          await auditRequired({
            clientId, estateId: tenancy.estateId, userId: actor?._id,
            action: 'MPESA_COLLECTION_REFERENCE_ISSUED', resource: 'MpesaCollectionReference', resourceId: String(created._id),
            description: 'Issued a PayBill collection reference',
            metadata: { merchantProfileId: String(merchantProfileId), tenancyId: String(tenancyId), tenantId: String(tenancy.tenantId) },
            ipAddress: reqMeta.ip, userAgent: reqMeta.userAgent,
          }, { session });
        });
        return { reference: row, created: true };
      } catch (err) {
        const which = duplicateKeyIndex(err);
        if (which === 'active_tenancy') {
          // Another request already issued the single ACTIVE reference for this tenancy: return it.
          const existing = await MpesaCollectionReference.findOne({ merchantProfileId, tenancyId, clientId, status: 'ACTIVE' });
          if (existing) return { reference: existing, created: false };
          throw Errors.Conflict('Reference issuance conflict; retry');
        }
        if (which === 'reference') continue; // candidate collided: draw a new one
        if (which === 'unknown') throw Errors.Conflict('Reference issuance conflict; retry');
        throw err;
      } finally {
        await session.endSession();
      }
    }
    throw Errors.Conflict('Could not generate a unique reference; retry');
  },

  /** Retire; never reassign. A retired reference keeps its original tenant/tenancy forever. */
  async retire({ clientId, referenceId, reason = 'ADMIN', actor, reqMeta = {} }) {
    const session = await mongoose.startSession();
    let row;
    try {
      await session.withTransaction(async () => {
        row = await MpesaCollectionReference.findOneAndUpdate(
          { _id: referenceId, clientId, status: 'ACTIVE' },
          { $set: { status: 'RETIRED', retiredAt: new Date(), retiredReason: reason, retiredByUserId: actor?._id || null } },
          { new: true, session },
        );
        if (!row) throw Errors.NotFound('Active reference not found');
        await auditRequired({
          clientId, estateId: row.estateId, userId: actor?._id,
          action: 'MPESA_COLLECTION_REFERENCE_RETIRED', resource: 'MpesaCollectionReference', resourceId: String(row._id),
          description: 'Retired a PayBill collection reference',
          metadata: { reason, merchantProfileId: String(row.merchantProfileId), tenancyId: String(row.tenancyId) },
          ipAddress: reqMeta.ip, userAgent: reqMeta.userAgent,
        }, { session });
      });
    } finally {
      await session.endSession();
    }
    return row;
  },
};
