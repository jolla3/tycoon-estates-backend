// src/models/MpesaMerchantProfileEstate.js
//
// Explicit mapping: one merchant profile (shortcode) -> many same-client estates.
// An INACTIVE mapping never authorizes anything. Mapping to an estate is NOT receipt
// attribution: receipts are attributed only by exact reference/evidence resolution.
// autoIndex: false — unique index is migration-controlled only.

import mongoose from 'mongoose';

const { Schema } = mongoose;

const MpesaMerchantProfileEstateSchema = new Schema(
  {
    merchantProfileId: { type: Schema.Types.ObjectId, ref: 'MpesaMerchantProfile', required: true },
    clientId: { type: Schema.Types.ObjectId, ref: 'Client', required: true },
    estateId: { type: Schema.Types.ObjectId, ref: 'Estate', required: true },
    status: { type: String, enum: ['ACTIVE', 'INACTIVE'], default: 'ACTIVE', required: true },
    source: { type: String, enum: ['SUPERADMIN', 'LEGACY_MIGRATION'], default: 'SUPERADMIN' },
    createdByUserId: { type: Schema.Types.ObjectId, ref: 'User', default: null },
    deactivatedAt: { type: Date, default: null },
    deactivatedByUserId: { type: Schema.Types.ObjectId, ref: 'User', default: null },
  },
  { timestamps: true, autoIndex: false, collection: 'mpesamerchantprofileestates' }
);

MpesaMerchantProfileEstateSchema.index(
  { merchantProfileId: 1, estateId: 1 },
  { unique: true, name: 'uniq_mpesa_profile_estate' }
);
MpesaMerchantProfileEstateSchema.index(
  { clientId: 1, estateId: 1, status: 1 },
  { name: 'idx_mpesa_profile_estate_scope' }
);

export const MpesaMerchantProfileEstate = mongoose.model(
  'MpesaMerchantProfileEstate',
  MpesaMerchantProfileEstateSchema
);
