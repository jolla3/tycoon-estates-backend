// src/models/RentCharge.js
//
// Generalized billing charge. Historically rent-only; now supports
// RENT | WATER | ELECTRICITY | OTHER via chargeType while preserving
// existing documents (default chargeType = RENT).
import mongoose from 'mongoose';
const { Schema } = mongoose;

const RentChargeSchema = new Schema(
  {
    clientId: { type: Schema.Types.ObjectId, ref: 'Client', required: true, index: true },
    estateId: { type: Schema.Types.ObjectId, ref: 'Estate', required: true, index: true },
    houseId: { type: Schema.Types.ObjectId, ref: 'House', required: true },
    tenantId: { type: Schema.Types.ObjectId, ref: 'Tenant' },
    period: { type: String, required: true }, // 'YYYY-MM' in Nairobi time
    chargeType: {
      type: String,
      enum: ['RENT', 'WATER', 'ELECTRICITY', 'OTHER'],
      default: 'RENT',
      required: true,
    },
    description: { type: String, default: '' },
    amountDueCents: { type: Number, required: true },
    amountPaidCents: { type: Number, default: 0 },
    balanceCents: { type: Number, required: true },
    status: { type: String, enum: ['PAID', 'PARTIAL', 'UNPAID', 'OVERPAID'], default: 'UNPAID' },
    dueDate: Date,
  },
  { timestamps: true }
);

// Unique per house+period+chargeType (allows rent + water in same month).
// chargeType + description: allows multiple OTHER lines (Security, Garbage, …)
// while RENT/WATER/ELECTRICITY stay unique via fixed descriptions.
RentChargeSchema.index(
  { clientId: 1, houseId: 1, period: 1, chargeType: 1, description: 1 },
  { unique: true }
);
RentChargeSchema.index({ estateId: 1, period: 1, status: 1 });
RentChargeSchema.index({ clientId: 1, period: 1, status: 1 });
RentChargeSchema.index({ houseId: 1, status: 1 });

export const RentCharge = mongoose.model('RentCharge', RentChargeSchema);
