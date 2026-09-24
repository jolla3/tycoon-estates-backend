// src/models/Payment.js
import mongoose from 'mongoose';
const { Schema } = mongoose;

const PaymentSchema = new Schema(
  {
    clientId: { type: Schema.Types.ObjectId, ref: 'Client', required: true, index: true },
    estateId: { type: Schema.Types.ObjectId, ref: 'Estate', required: true, index: true },
    houseId: { type: Schema.Types.ObjectId, ref: 'House', required: true },
    tenantId: { type: Schema.Types.ObjectId, ref: 'Tenant' },
    // Unique + sparse: at most one Payment per BankTransaction, prevents
    // duplicate payment creation on webhook/sync retries (section 13).
    bankTransactionId: { type: Schema.Types.ObjectId, ref: 'BankTransaction', unique: true, sparse: true },
    amountCents: { type: Number, required: true },
    paymentDate: { type: Date, required: true },
    paymentReference: String,
    period: String,
    status: { type: String, enum: ['CONFIRMED', 'REVERSED'], default: 'CONFIRMED' },
  },
  { timestamps: true }
);

PaymentSchema.index({ estateId: 1, houseId: 1, period: 1 });
PaymentSchema.index({ clientId: 1, paymentDate: -1 });

export const Payment = mongoose.model('Payment', PaymentSchema);
