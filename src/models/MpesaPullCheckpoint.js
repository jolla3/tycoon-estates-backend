// src/models/MpesaPullCheckpoint.js
//
// G5.3 — Per-shortcode Pull query cursor.
// Unique merchantProfileId index is migration-controlled (autoIndex: false).

import mongoose from 'mongoose';

const { Schema } = mongoose;

const MpesaPullCheckpointSchema = new Schema(
  {
    clientId: { type: Schema.Types.ObjectId, ref: 'Client', required: true },
    merchantProfileId: {
      type: Schema.Types.ObjectId,
      ref: 'MpesaMerchantProfile',
      required: true,
    },
    businessShortCode: { type: String, required: true },
    windowStartAt: { type: Date, default: null },
    windowEndAt: { type: Date, default: null },
    lastOffsetValue: { type: String, default: '0' },
    lastQueryStatus: {
      type: String,
      enum: ['IDLE', 'RUNNING', 'SUCCEEDED', 'FAILED', 'UNCERTAIN'],
      default: 'IDLE',
    },
    lastQueryAt: { type: Date, default: null },
    lastErrorCode: { type: String, default: null },
    leaseOwner: { type: String, default: null },
    leaseExpiresAt: { type: Date, default: null },
    lastQueryReference: { type: String, default: null },
  },
  { timestamps: true, autoIndex: false, collection: 'mpesapullcheckpoints' }
);

MpesaPullCheckpointSchema.index(
  { merchantProfileId: 1 },
  { unique: true, name: 'uniq_mpesa_pull_checkpoint_profile' }
);

export const MpesaPullCheckpoint = mongoose.model(
  'MpesaPullCheckpoint',
  MpesaPullCheckpointSchema
);
