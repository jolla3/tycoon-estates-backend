// src/models/MpesaMerchantProfile.js
//
// G5.3 — Merchant/shortcode configuration for Buy Goods ingestion.
// Credential material is NOT stored here (B09). Operational flags are evidence-backed.
// autoIndex: false — unique index is migration-controlled only.

import mongoose from 'mongoose';

const { Schema } = mongoose;

const MpesaMerchantProfileSchema = new Schema(
  {
    clientId: { type: Schema.Types.ObjectId, ref: 'Client', required: true, index: true },
    provider: { type: String, required: true, default: 'SAFARICOM', enum: ['SAFARICOM'] },
    merchantType: {
      type: String,
      required: true,
      default: 'BUY_GOODS_TILL',
      enum: ['BUY_GOODS_TILL'],
    },
    displayName: { type: String, default: null },
    businessShortCode: { type: String, required: true },
    estateId: { type: Schema.Types.ObjectId, ref: 'Estate', default: null },
    callbackCapability: {
      type: String,
      enum: ['UNKNOWN', 'NOT_ENABLED', 'VERIFIED'],
      default: 'UNKNOWN',
    },
    pullCapability: {
      type: String,
      enum: ['UNKNOWN', 'NOT_ENABLED', 'VERIFIED'],
      default: 'UNKNOWN',
    },
    operationalState: {
      type: String,
      enum: ['DRAFT', 'NOT_READY', 'ACTIVE', 'SUSPENDED'],
      default: 'DRAFT',
      index: true,
    },
    c2bRegistrationState: {
      type: String,
      enum: ['NONE', 'REQUESTED', 'ACCEPTED', 'ALREADY_REGISTERED', 'REJECTED', 'UNCERTAIN'],
      default: 'NONE',
    },
    pullRegistrationState: {
      type: String,
      enum: ['NONE', 'REQUESTED', 'ACCEPTED', 'ALREADY_REGISTERED', 'REJECTED', 'UNCERTAIN'],
      default: 'NONE',
    },
    lastC2bRegisteredAt: { type: Date, default: null },
    lastPullRegisteredAt: { type: Date, default: null },
    createdByUserId: { type: Schema.Types.ObjectId, ref: 'User', default: null },
    updatedByUserId: { type: Schema.Types.ObjectId, ref: 'User', default: null },
  },
  { timestamps: true, autoIndex: false, collection: 'mpesamerchantprofiles' }
);

/**
 * Unique {clientId, businessShortCode} is migration-controlled only.
 * autoIndex: false — schema declaration documents intent; boot must not install it.
 */
MpesaMerchantProfileSchema.index(
  { clientId: 1, businessShortCode: 1 },
  { unique: true, name: 'uniq_client_business_shortcode' }
);
MpesaMerchantProfileSchema.index({ clientId: 1, operationalState: 1 });

export const MpesaMerchantProfile = mongoose.model(
  'MpesaMerchantProfile',
  MpesaMerchantProfileSchema
);
