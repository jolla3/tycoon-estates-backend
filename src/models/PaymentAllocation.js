// src/models/PaymentAllocation.js
//
// Links a Payment to one or more billing charges (RentCharge rows).
// Enables multi-charge allocation of a single bank payment.

import mongoose from 'mongoose';
const { Schema } = mongoose;

const PaymentAllocationSchema = new Schema(
  {
    clientId: { type: Schema.Types.ObjectId, ref: 'Client', required: true, index: true },
    estateId: { type: Schema.Types.ObjectId, ref: 'Estate', required: true, index: true },
    paymentId: { type: Schema.Types.ObjectId, ref: 'Payment', required: true, index: true },
    // Points at RentCharge (which may represent RENT/WATER/ELECTRICITY/OTHER
    // once chargeType is set on that model).
    rentChargeId: { type: Schema.Types.ObjectId, ref: 'RentCharge', required: true, index: true },
    amountCents: { type: Number, required: true, min: 1 },
    chargeType: {
      type: String,
      enum: ['RENT', 'WATER', 'ELECTRICITY', 'OTHER'],
      default: 'RENT',
    },
    period: { type: String, required: true }, // YYYY-MM
  },
  { timestamps: true }
);

PaymentAllocationSchema.index({ paymentId: 1, rentChargeId: 1 }, { unique: true });
PaymentAllocationSchema.index({ clientId: 1, period: 1 });

export const PaymentAllocation = mongoose.model('PaymentAllocation', PaymentAllocationSchema);
