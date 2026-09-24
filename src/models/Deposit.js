// Security deposit — separate from rent revenue.
// Ledger entries: DEPOSIT_RECEIVED (+ liability), DEPOSIT_DEDUCTION, DEPOSIT_REFUND
import mongoose from 'mongoose';
const { Schema } = mongoose;

const DeductionSchema = new Schema(
  {
    amountCents: { type: Number, required: true, min: 1 },
    reason: { type: String, required: true, trim: true },
    notes: { type: String, default: '' },
    deductedAt: { type: Date, default: Date.now },
    actorUserId: { type: Schema.Types.ObjectId, ref: 'User' },
  },
  { _id: true }
);

const DepositSchema = new Schema(
  {
    clientId: { type: Schema.Types.ObjectId, ref: 'Client', required: true, index: true },
    estateId: { type: Schema.Types.ObjectId, ref: 'Estate', required: true, index: true },
    houseId: { type: Schema.Types.ObjectId, ref: 'House', required: true, index: true },
    tenantId: { type: Schema.Types.ObjectId, ref: 'Tenant', required: true, index: true },
    requiredCents: { type: Number, required: true, min: 0 },
    paidCents: { type: Number, default: 0, min: 0 },
    heldCents: { type: Number, default: 0, min: 0 },
    refundedCents: { type: Number, default: 0, min: 0 },
    status: {
      type: String,
      enum: ['REQUIRED', 'PARTIAL', 'HELD', 'SETTLED', 'REFUNDED'],
      default: 'REQUIRED',
    },
    deductions: { type: [DeductionSchema], default: [] },
    moveInDate: Date,
    settledAt: Date,
  },
  { timestamps: true }
);

DepositSchema.index({ clientId: 1, tenantId: 1 }, { unique: true });
DepositSchema.index({ clientId: 1, houseId: 1 });

export const Deposit = mongoose.model('Deposit', DepositSchema);
