// src/models/MpesaTransaction.js
//
// G5.3 — Canonical merchant-side M-PESA receipt.
// Provider ingestion only — no G3 Payment posting in this slice.
// Explicit collection: mpesatransactions
// autoIndex: false — provisional unique index is migration-controlled only.

import mongoose from 'mongoose';
import {
  DARAJA_PROVIDER,
  TXN_VERIFICATION_STATE,
} from '../services/mpesa/daraja.constants.js';

const { Schema } = mongoose;

const MpesaTransactionSchema = new Schema(
  {
    provider: { type: String, required: true, default: DARAJA_PROVIDER },
    clientId: { type: Schema.Types.ObjectId, ref: 'Client', default: null, index: true },
    merchantProfileId: {
      type: Schema.Types.ObjectId,
      ref: 'MpesaMerchantProfile',
      default: null,
      index: true,
    },
    businessShortCode: { type: String, required: true },
    receiptNumber: { type: String, required: true },
    amountCents: { type: Number, required: true },
    currency: { type: String, default: 'KES' },
    transactionAt: { type: Date, required: true },
    billRefNumber: { type: String, default: null },
    transactionType: { type: String, default: null },
    sourceChannels: {
      type: [String],
      default: [],
    },
    verificationState: {
      type: String,
      enum: Object.values(TXN_VERIFICATION_STATE),
      default: TXN_VERIFICATION_STATE.UNVERIFIED,
      index: true,
    },
    conflictReason: { type: String, default: null },
    acceptedAmountCents: { type: Number, required: true },
    acceptedTransactionAt: { type: Date, required: true },
    claimState: {
      type: String,
      enum: ['UNCLAIMED', 'CLAIMED', 'REVIEW', 'REJECTED'],
      default: 'UNCLAIMED',
    },
    postingState: {
      type: String,
      enum: ['NOT_POSTED', 'PROCESSING', 'POSTED', 'FAILED_RETRYABLE', 'FAILED_TERMINAL'],
      default: 'NOT_POSTED',
    },
    paymentId: { type: Schema.Types.ObjectId, ref: 'Payment', default: null },
    /** Future multi-tenancy child Payments (G5.1) — no G3 writes in this slice. */
    paymentIds: { type: [{ type: Schema.Types.ObjectId, ref: 'Payment' }], default: [] },
  },
  { timestamps: true, collection: 'mpesatransactions', autoIndex: false }
);

MpesaTransactionSchema.path('amountCents').validate(
  (v) => Number.isSafeInteger(v) && v >= 0,
  'amountCents must be a non-negative safe integer'
);

/**
 * Provisional uniqueness: provider + shortcode + receipt.
 * Scope remains PROPOSED until B01/B02 prove merchant hierarchy identity.
 * Declared for documentation; autoIndex is false so boot does not install it.
 * Guarded migration + readiness gate required before treating as authority.
 * Do not treat this alone as authority to post G3 Payments.
 */
MpesaTransactionSchema.index(
  { provider: 1, businessShortCode: 1, receiptNumber: 1 },
  { unique: true, name: 'uniq_safaricom_shortcode_receipt_provisional' }
);
MpesaTransactionSchema.index({ verificationState: 1, transactionAt: -1 });
MpesaTransactionSchema.index({ clientId: 1, transactionAt: -1 });

export const MpesaTransaction = mongoose.model('MpesaTransaction', MpesaTransactionSchema);
