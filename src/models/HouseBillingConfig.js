// src/models/HouseBillingConfig.js
//
// Per-house (or estate-default) recurring charge definitions.
// chargeType: RENT | WATER | ELECTRICITY | OTHER
// Amounts are integer cents. Frequency is monthly for the current product.

import mongoose from 'mongoose';
const { Schema } = mongoose;

const HouseBillingConfigSchema = new Schema(
  {
    clientId: { type: Schema.Types.ObjectId, ref: 'Client', required: true, index: true },
    estateId: { type: Schema.Types.ObjectId, ref: 'Estate', required: true, index: true },
    houseId: { type: Schema.Types.ObjectId, ref: 'House', required: true, index: true },
    chargeType: {
      type: String,
      enum: ['RENT', 'WATER', 'ELECTRICITY', 'OTHER'],
      required: true,
    },
    description: { type: String, default: '' },
    amountCents: { type: Number, required: true, min: 0 },
    // 1–31, Nairobi calendar day (clamped to month end). Falls back to house.dueDay / estate default.
    dueDay: { type: Number, min: 1, max: 31 },
    frequency: { type: String, enum: ['monthly'], default: 'monthly' },
    isActive: { type: Boolean, default: true },
    effectiveFrom: { type: Date, default: Date.now },
    effectiveTo: { type: Date, default: null },
  },
  { timestamps: true }
);

// One active config per charge type per house (enforced at service layer;
// unique index is soft because historical effective ranges may overlap).
HouseBillingConfigSchema.index({ houseId: 1, chargeType: 1, isActive: 1 });
HouseBillingConfigSchema.index({ clientId: 1, estateId: 1 });

export const HouseBillingConfig = mongoose.model('HouseBillingConfig', HouseBillingConfigSchema);
