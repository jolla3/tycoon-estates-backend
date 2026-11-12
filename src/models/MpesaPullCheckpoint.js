// src/models/MpesaPullCheckpoint.js
//
// G5.3 — Per-shortcode Pull query cursor. Schema is operational; window rules
// still depend on the verified 48h provider limit (SECONDARY evidence).

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
    /** Inclusive start of last successful fully ingested window (UTC). */
    windowStartAt: { type: Date, default: null },
    /** Exclusive end of last successful fully ingested window (UTC). */
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
  },
  { timestamps: true }
);

MpesaPullCheckpointSchema.index(
  { merchantProfileId: 1 },
  { unique: true }
);

export const MpesaPullCheckpoint = mongoose.model(
  'MpesaPullCheckpoint',
  MpesaPullCheckpointSchema
);
