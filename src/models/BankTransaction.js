// src/models/BankTransaction.js
//
// G4 Batch 03: direction is never defaulted; connectionId records first-accepted
// connection provenance; valueDate is distinct from transactionDate.

import mongoose from 'mongoose';
const { Schema } = mongoose;

const PROCESSING_STATES = [
  'RECEIVED', 'CLAIMED', 'POSTED', 'FAILED_RETRYABLE', 'FAILED_TERMINAL', 'MANUAL_REVIEW',
];

const BankTransactionSchema = new Schema(
  {
    clientId: { type: Schema.Types.ObjectId, ref: 'Client', required: true, index: true },
    estateId: { type: Schema.Types.ObjectId, ref: 'Estate', required: true, index: true },
    bankAccountId: { type: Schema.Types.ObjectId, ref: 'BankAccount', required: true },
    /**
     * Connection that first accepted this transaction. Immutable after insert —
     * reconnect does not rewrite provenance.
     */
    connectionId: {
      type: Schema.Types.ObjectId,
      ref: 'BankConnection',
      default: null,
      index: true,
    },
    provider: { type: String, required: true },
    providerTransactionId: { type: String, required: true },
    amountCents: { type: Number, required: true },
    currency: { type: String, default: 'KES' },
    /** Posting / transaction date used by G3 historical tenancy matching. */
    transactionDate: { type: Date, required: true },
    /** Settlement/value date when the provider supplies it — not a substitute for transactionDate. */
    valueDate: { type: Date, default: null },
    paymentReference: String,
    narration: String,
    /** Explicit CREDIT or DEBIT only — no schema default. */
    eventType: { type: String, enum: ['CREDIT', 'DEBIT'], required: true },
    rawReference: String,
    bookedBalanceCents: { type: Number, default: null },
    clearedBalanceCents: { type: Number, default: null },
    sourceChannel: {
      type: String,
      enum: ['poll', 'webhook', 'import', 'unknown'],
      default: 'unknown',
    },
    schemaUnverified: { type: Boolean, default: false },
    matchedHouseId: { type: Schema.Types.ObjectId, ref: 'House', default: null },
    matchedTenantId: { type: Schema.Types.ObjectId, ref: 'Tenant', default: null },
    matchedTenancyId: { type: Schema.Types.ObjectId, ref: 'Tenancy', default: null },
    matchStatus: {
      type: String,
      enum: ['MATCHED', 'UNMATCHED', 'PARTIAL', 'MANUAL_REVIEW'],
      default: 'UNMATCHED',
    },
    processingState: {
      type: String,
      enum: PROCESSING_STATES,
      default: 'RECEIVED',
      index: true,
    },
    processingClaimToken: { type: String, default: null },
    processingClaimExpiresAt: { type: Date, default: null },
    processingAttempts: { type: Number, default: 0 },
    lastProcessingError: { type: String, default: null },
    rawPayload: Schema.Types.Mixed,
  },
  { timestamps: true }
);

BankTransactionSchema.index({ estateId: 1, bankAccountId: 1, transactionDate: 1 });
// Existing unique identity — preserved.
BankTransactionSchema.index({ provider: 1, providerTransactionId: 1 }, { unique: true });
BankTransactionSchema.index({ estateId: 1, paymentReference: 1 });
BankTransactionSchema.index({ estateId: 1, matchStatus: 1 });
BankTransactionSchema.index({ clientId: 1, transactionDate: -1 });
BankTransactionSchema.index({ clientId: 1, matchStatus: 1 });
BankTransactionSchema.index({ processingState: 1, updatedAt: 1 });
BankTransactionSchema.index({ processingState: 1, processingClaimExpiresAt: 1 });

export const BankTransaction = mongoose.model('BankTransaction', BankTransactionSchema);
export const BANK_PROCESSING_STATES = PROCESSING_STATES;
