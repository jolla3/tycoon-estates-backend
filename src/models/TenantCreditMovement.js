// src/models/TenantCreditMovement.js
//
// G3-owned, IMMUTABLE Tenant-level credit movement (G5 extension).
// Identity of the account: { clientId, estateId, tenantId }.
// The balance is ALWAYS derived by summing movements; there is no stored balance.
// Serialization of concurrent credit writers is done by bumping Tenant.creditRev
// (non-monetary CAS token) inside the same MongoDB transaction.
// autoIndex:false — unique idempotency identity is migration-controlled.

import mongoose from 'mongoose';

const { Schema } = mongoose;

export const CREDIT_MOVEMENT_TYPE = Object.freeze({
  RECEIPT_SURPLUS: 'RECEIPT_SURPLUS',   // +  surplus from a verified receipt
  CREDIT_APPLIED: 'CREDIT_APPLIED',     // -  credit consumed against a RentCharge
  ADJUSTMENT: 'ADJUSTMENT',             // +/- reserved for audited manual correction
});

const TenantCreditMovementSchema = new Schema(
  {
    clientId: { type: Schema.Types.ObjectId, ref: 'Client', required: true },
    estateId: { type: Schema.Types.ObjectId, ref: 'Estate', required: true },
    tenantId: { type: Schema.Types.ObjectId, ref: 'Tenant', required: true },
    movementType: { type: String, enum: Object.values(CREDIT_MOVEMENT_TYPE), required: true },
    amountCents: { type: Number, required: true },
    // Exact provenance
    mpesaTransactionId: { type: Schema.Types.ObjectId, ref: 'MpesaTransaction', default: null },
    paymentId: { type: Schema.Types.ObjectId, ref: 'Payment', default: null },
    tenancyId: { type: Schema.Types.ObjectId, ref: 'Tenancy', default: null },
    rentChargeId: { type: Schema.Types.ObjectId, ref: 'RentCharge', default: null },
    // Deterministic idempotency identity of this movement.
    idempotencyKey: { type: String, required: true },
    // Tenant.creditRev value after the serialization bump (audit aid, not authority).
    creditRevAtWrite: { type: Number, default: null },
    description: { type: String, default: '' },
  },
  { timestamps: { createdAt: true, updatedAt: false }, autoIndex: false, collection: 'tenantcreditmovements' }
);

TenantCreditMovementSchema.path('amountCents').validate(
  (v) => Number.isSafeInteger(v) && v !== 0,
  'amountCents must be a non-zero safe integer'
);

// Immutability: no update/delete through Mongoose document or query middleware.
for (const op of ['updateOne', 'updateMany', 'findOneAndUpdate', 'findOneAndReplace',
  'replaceOne', 'deleteOne', 'deleteMany', 'findOneAndDelete']) {
  TenantCreditMovementSchema.pre(op, function immutable() {
    throw new Error('TenantCreditMovement is immutable');
  });
}

export const CREDIT_MOVEMENT_INDEXES = Object.freeze({
  IDEMPOTENCY: {
    name: 'uniq_tenant_credit_movement_key',
    key: { clientId: 1, estateId: 1, tenantId: 1, idempotencyKey: 1 },
    unique: true,
  },
});
TenantCreditMovementSchema.index(
  CREDIT_MOVEMENT_INDEXES.IDEMPOTENCY.key,
  { unique: true, name: CREDIT_MOVEMENT_INDEXES.IDEMPOTENCY.name }
);
TenantCreditMovementSchema.index({ clientId: 1, estateId: 1, tenantId: 1, createdAt: 1 });
TenantCreditMovementSchema.index({ mpesaTransactionId: 1 });

export const TenantCreditMovement = mongoose.model('TenantCreditMovement', TenantCreditMovementSchema);
