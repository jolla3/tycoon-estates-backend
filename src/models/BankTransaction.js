// src/models/BankTransaction.js
//
// Provider-neutral normalized transaction (section 10). Nothing outside
// the banking provider that produced this document should ever need to
// know the original payload shape — it's kept in rawPayload purely for
// audit/debugging.
import mongoose from 'mongoose';
const { Schema } = mongoose;

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
    matchStatus: { type: String, enum: ['MATCHED', 'UNMATCHED', 'PARTIAL', 'MANUAL_REVIEW'], default: 'UNMATCHED' },
    rawPayload: Schema.Types.Mixed,
  },
  { timestamps: true }
);

BankTransactionSchema.index({ estateId: 1, bankAccountId: 1, transactionDate: 1 });
// Duplicate-processing guard (section 13): the same bank can never create
// two BankTransaction documents for the same providerTransactionId.
BankTransactionSchema.index({ provider: 1, providerTransactionId: 1 }, { unique: true });
BankTransactionSchema.index({ estateId: 1, paymentReference: 1 });
BankTransactionSchema.index({ estateId: 1, matchStatus: 1 });
BankTransactionSchema.index({ clientId: 1, transactionDate: -1 });
BankTransactionSchema.index({ clientId: 1, matchStatus: 1 });

export const BankTransaction = mongoose.model('BankTransaction', BankTransactionSchema);
