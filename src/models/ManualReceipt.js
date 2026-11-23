// src/models/ManualReceipt.js
//
// Canonical envelope for one operator-recorded manual receipt.
// This is an audit/identity record for the GROSS amount received. It is NOT a
// ledger posting. Applied amounts still land in child Payment + PaymentAllocation
// + Ledger PAYMENT rows; surplus lands in TenantCreditMovement.
//
// Invariant (new receipt only):
//   amountCents = receiptAppliedCents + newCreditCents
// Existing tenant credit applied to charges is tracked separately and is not
// part of this receipt's gross amount.
//
// Unique indexes are migration-controlled (see scripts/migrations and
// src/utils/manualReceiptIndexReadiness.js). autoIndex remains false.

import mongoose from 'mongoose';

const { Schema } = mongoose;

const TENDER_METHODS = ['CASH', 'CHEQUE', 'BANK_TRANSFER', 'MPESA', 'OTHER'];

const ManualReceiptSchema = new Schema(
  {
    clientId: { type: Schema.Types.ObjectId, ref: 'Client', required: true },
    estateId: { type: Schema.Types.ObjectId, ref: 'Estate', required: true },
    // Originating house of the physical receipt (may differ from obligation houses).
    houseId: { type: Schema.Types.ObjectId, ref: 'House', required: true },
    tenantId: { type: Schema.Types.ObjectId, ref: 'Tenant', required: true },
    // Tenancy covering the Nairobi payment date (may be CLOSED for backdated receipts).
    occupancyTenancyId: { type: Schema.Types.ObjectId, ref: 'Tenancy', required: true },
    // Nairobi calendar date as submitted (YYYY-MM-DD).
    paymentDateLocal: { type: String, required: true },
    // Stable UTC instant representing that Nairobi calendar day (noon Nairobi).
    paymentDate: { type: Date, required: true },
    // Nairobi accounting period derived from paymentDateLocal (YYYY-MM).
    period: { type: String, required: true },
    tenderMethod: { type: String, enum: TENDER_METHODS, required: true },
    // Gross amount physically received (integer cents).
    amountCents: { type: Number, required: true },
    // Optional external evidence/reference (business identity, not submission key).
    paymentReference: { type: String, default: null },
    // Client-scoped submission identity. Frontend generates once per intended submit.
    idempotencyKey: { type: String, required: true },
    recordedByUserId: { type: Schema.Types.ObjectId, ref: 'User', default: null },
    // Settlement snapshot (filled after settleTenantAccount).
    creditAppliedCents: { type: Number, default: 0 },
    receiptAppliedCents: { type: Number, default: 0 },
    newCreditCents: { type: Number, default: 0 },
    creditBeforeCents: { type: Number, default: null },
    creditRemainingCents: { type: Number, default: null },
    creditAfterCents: { type: Number, default: null },
    settlementVersion: { type: Number, default: null },
    paymentIds: [{ type: Schema.Types.ObjectId, ref: 'Payment' }],
    creditPaymentIds: [{ type: Schema.Types.ObjectId, ref: 'Payment' }],
    creditMovementIds: [{ type: Schema.Types.ObjectId, ref: 'TenantCreditMovement' }],
    status: { type: String, enum: ['CONFIRMED'], default: 'CONFIRMED' },
  },
  {
    timestamps: { createdAt: true, updatedAt: false },
    autoIndex: false,
    collection: 'manualreceipts',
  }
);

ManualReceiptSchema.path('amountCents').validate(
  (v) => Number.isSafeInteger(v) && v > 0,
  'amountCents must be a positive safe integer'
);

ManualReceiptSchema.path('paymentDateLocal').validate(
  (v) => /^\d{4}-(0[1-9]|1[0-2])-(0[1-9]|[12]\d|3[01])$/.test(String(v || '')),
  'paymentDateLocal must be YYYY-MM-DD'
);

export const MANUAL_RECEIPT_INDEXES = Object.freeze({
  IDEMPOTENCY: {
    name: 'uniq_client_manual_receipt_idempotency',
    key: { clientId: 1, idempotencyKey: 1 },
    unique: true,
  },
  REFERENCE: {
    name: 'uniq_client_manual_receipt_reference',
    key: { clientId: 1, paymentReference: 1 },
    unique: true,
    partialFilterExpression: {
      paymentReference: { $type: 'string', $gt: '' },
    },
  },
});

// Declared for documentation; installation is migration-controlled.
ManualReceiptSchema.index(
  MANUAL_RECEIPT_INDEXES.IDEMPOTENCY.key,
  { unique: true, name: MANUAL_RECEIPT_INDEXES.IDEMPOTENCY.name }
);
ManualReceiptSchema.index(
  MANUAL_RECEIPT_INDEXES.REFERENCE.key,
  {
    unique: true,
    name: MANUAL_RECEIPT_INDEXES.REFERENCE.name,
    partialFilterExpression: MANUAL_RECEIPT_INDEXES.REFERENCE.partialFilterExpression,
  }
);
ManualReceiptSchema.index({ clientId: 1, estateId: 1, paymentDate: -1 });
ManualReceiptSchema.index({ clientId: 1, tenantId: 1, paymentDate: -1 });

export const ManualReceipt = mongoose.model('ManualReceipt', ManualReceiptSchema);
