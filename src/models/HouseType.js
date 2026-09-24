// src/models/HouseType.js
// Client-scoped unit classification (Bedsitter, 1 Bedroom, Shop, …).
// Names are configured per client — never hard-coded in the database.
import mongoose from 'mongoose';
const { Schema } = mongoose;

const DefaultBillingLineSchema = new Schema(
  {
    chargeType: {
      type: String,
      enum: ['RENT', 'WATER', 'ELECTRICITY', 'OTHER'],
      required: true,
    },
    description: { type: String, default: '' },
    amountCents: { type: Number, required: true, min: 0 },
    dueDay: { type: Number, min: 1, max: 31 },
  },
  { _id: false }
);

const HouseTypeSchema = new Schema(
  {
    clientId: { type: Schema.Types.ObjectId, ref: 'Client', required: true, index: true },
    name: { type: String, required: true, trim: true },
    description: { type: String, default: '' },
    // Primary default rent in integer cents (also mirrored as a RENT line).
    defaultRentCents: { type: Number, default: 0, min: 0 },
    defaultDueDay: { type: Number, min: 1, max: 31 },
    // Optional additional default charge lines applied when a house is created
    // with this type. Changing these does NOT rewrite historical RentCharges.
    defaultBilling: { type: [DefaultBillingLineSchema], default: [] },
    isActive: { type: Boolean, default: true },
  },
  { timestamps: true }
);

// Unique name per client. Case-insensitive via collation so concurrent
// creates cannot race past the service-layer name check.
HouseTypeSchema.index(
  { clientId: 1, name: 1 },
  { unique: true, collation: { locale: 'en', strength: 2 } }
);

export const HouseType = mongoose.model('HouseType', HouseTypeSchema);
