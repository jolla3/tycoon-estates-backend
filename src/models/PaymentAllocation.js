// Links a Payment to one or more billing charges (RentCharge rows).
import mongoose from 'mongoose';
const { Schema } = mongoose;

const PaymentAllocationSchema = new Schema(
  {
    clientId: { type: Schema.Types.ObjectId, ref: 'Client', required: true, index: true },
    estateId: { type: Schema.Types.ObjectId, ref: 'Estate', required: true, index: true },
    paymentId: { type: Schema.Types.ObjectId, ref: 'Payment', required: true, index: true },
    tenancyId: { type: Schema.Types.ObjectId, ref: 'Tenancy', default: null, index: true },
    rentChargeId: { type: Schema.Types.ObjectId, ref: 'RentCharge', required: true, index: true },
    amountCents: {
      type: Number,
      required: true,
      validate: {
        validator(v) {
          return Number.isInteger(v) && v > 0 && Number.isSafeInteger(v);
        },
        message: 'amountCents must be a positive safe integer',
      },
    },
    chargeType: {
      type: String,
      enum: ['RENT', 'WATER', 'ELECTRICITY', 'OTHER'],
      default: 'RENT',
    },
    period: { type: String, required: true }, // YYYY-MM
  },
  { timestamps: true }
);

// Unique identity of an allocation line remains (paymentId, rentChargeId).
PaymentAllocationSchema.index({ paymentId: 1, rentChargeId: 1 }, { unique: true });
PaymentAllocationSchema.index({ clientId: 1, period: 1 });
PaymentAllocationSchema.index({ tenancyId: 1, paymentId: 1 });

export const PaymentAllocation = mongoose.model('PaymentAllocation', PaymentAllocationSchema);
