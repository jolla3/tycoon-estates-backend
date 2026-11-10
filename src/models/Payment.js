// src/models/Payment.js
import mongoose from 'mongoose';
const { Schema } = mongoose;

const PAYMENT_ORIGINS = ['BANK', 'MANUAL', 'MPESA'];
const TENDER_METHODS = ['CASH', 'CHEQUE', 'BANK_TRANSFER', 'MPESA', 'OTHER', null];

const PaymentSchema = new Schema(
  {
    clientId: { type: Schema.Types.ObjectId, ref: 'Client', required: true, index: true },
    estateId: { type: Schema.Types.ObjectId, ref: 'Estate', required: true, index: true },
    houseId: { type: Schema.Types.ObjectId, ref: 'House', required: true },
    tenantId: { type: Schema.Types.ObjectId, ref: 'Tenant' },
    tenancyId: { type: Schema.Types.ObjectId, ref: 'Tenancy', default: null, index: true },
    origin: { type: String, enum: PAYMENT_ORIGINS, required: true },
    bankTransactionId: { type: Schema.Types.ObjectId, ref: 'BankTransaction', unique: true, sparse: true },
    mpesaReceiptId: { type: Schema.Types.ObjectId, default: null },
    tenderMethod: { type: String, enum: TENDER_METHODS, default: null },
    recordedByUserId: { type: Schema.Types.ObjectId, ref: 'User', default: null },
    recordedAt: { type: Date, default: null },
    evidenceReference: { type: String, default: null },
    amountCents: { type: Number, required: true },
    paymentDate: { type: Date, required: true },
    paymentReference: String,
    period: String,
    status: { type: String, enum: ['CONFIRMED', 'REVERSED'], default: 'CONFIRMED' },
    allocatedCents: { type: Number, default: 0 },
    // G3.3 non-monetary CAS token — not a monetary authority
    allocationRev: { type: Number, default: 0 },
  },
  { timestamps: true }
);

PaymentSchema.path('amountCents').validate(
  (value) => Number.isSafeInteger(value) && value > 0,
  'amountCents must be a positive safe integer'
);

// MANUAL paymentReference uniqueness is installed by the explicit G3.3 migration,
// after duplicate preflight. Do not add it to schema auto-index creation.
PaymentSchema.index({ estateId: 1, houseId: 1, period: 1 });
PaymentSchema.index({ clientId: 1, paymentDate: -1 });
PaymentSchema.index({ tenancyId: 1, paymentDate: -1 });
PaymentSchema.index(
  { mpesaReceiptId: 1 },
  { unique: true, partialFilterExpression: { mpesaReceiptId: { $type: 'objectId' } } }
);

export const Payment = mongoose.model('Payment', PaymentSchema);
export const PAYMENT_ORIGINS_LIST = PAYMENT_ORIGINS;
export const TENDER_METHODS_LIST = TENDER_METHODS;
