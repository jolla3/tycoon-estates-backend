// src/models/BankTransaction.js
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
    provider: { type: String, required: true },
    providerTransactionId: { type: String, required: true },
    amountCents: { type: Number, required: true },
    currency: { type: String, default: 'KES' },
    transactionDate: { type: Date, required: true },
    paymentReference: String,
    narration: String,
    eventType: { type: String, enum: ['CREDIT', 'DEBIT'], default: 'CREDIT' },
    rawReference: String,
    matchedHouseId: { type: Schema.Types.ObjectId, ref: 'House', default: null },
    matchedTenantId: { type: Schema.Types.ObjectId, ref: 'Tenant', default: null },
    matchedTenancyId: { type: Schema.Types.ObjectId, ref: 'Tenancy', default: null },
    matchStatus: { type: String, enum: ['MATCHED', 'UNMATCHED', 'PARTIAL', 'MANUAL_REVIEW'], default: 'UNMATCHED' },
    processingState: { type: String, enum: PROCESSING_STATES, default: 'RECEIVED', index: true },
    processingClaimToken: { type: String, default: null },
    processingClaimExpiresAt: { type: Date, default: null },
    processingAttempts: { type: Number, default: 0 },
    lastProcessingError: { type: String, default: null },
    rawPayload: Schema.Types.Mixed,
  },
  { timestamps: true }
);

BankTransactionSchema.index({ estateId: 1, bankAccountId: 1, transactionDate: 1 });
BankTransactionSchema.index({ provider: 1, providerTransactionId: 1 }, { unique: true });
BankTransactionSchema.index({ estateId: 1, paymentReference: 1 });
BankTransactionSchema.index({ estateId: 1, matchStatus: 1 });
BankTransactionSchema.index({ clientId: 1, transactionDate: -1 });
BankTransactionSchema.index({ clientId: 1, matchStatus: 1 });
BankTransactionSchema.index({ processingState: 1, updatedAt: 1 });

export const BankTransaction = mongoose.model('BankTransaction', BankTransactionSchema);
export const BANK_PROCESSING_STATES = PROCESSING_STATES;
