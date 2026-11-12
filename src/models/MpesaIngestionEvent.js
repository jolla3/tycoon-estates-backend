// src/models/MpesaIngestionEvent.js
//
// G5.3 — Durable provider ingress + quarantine (callback and Pull).
// Collection: mpesaingestionevents
// payloadDigest is diagnostic only — not a provider event uniqueness barrier.
// Event persistence and processing are separate stages (G5.1).

import mongoose from 'mongoose';
import {
  INGESTION_SOURCE,
  INGESTION_STATE,
  DARAJA_PROVIDER,
} from '../services/mpesa/daraja.constants.js';

const { Schema } = mongoose;

const MpesaIngestionEventSchema = new Schema(
  {
    provider: { type: String, required: true, default: DARAJA_PROVIDER },
    sourceChannel: {
      type: String,
      required: true,
      enum: Object.values(INGESTION_SOURCE),
      index: true,
    },
    merchantProfileId: {
      type: Schema.Types.ObjectId,
      ref: 'MpesaMerchantProfile',
      default: null,
      index: true,
    },
    clientId: { type: Schema.Types.ObjectId, ref: 'Client', default: null, index: true },
    businessShortCode: { type: String, default: null, index: true },
    receiptNumber: { type: String, default: null, index: true },
    receivedAt: { type: Date, required: true, default: Date.now, index: true },
    payloadDigest: { type: String, required: true, index: true },
    providerEventId: { type: String, default: null, index: true },
    payloadRedacted: { type: Schema.Types.Mixed, default: null },
    normalizedTransactionId: {
      type: Schema.Types.ObjectId,
      ref: 'MpesaTransaction',
      default: null,
      index: true,
    },
    state: {
      type: String,
      enum: Object.values(INGESTION_STATE),
      default: INGESTION_STATE.RECEIVED,
      index: true,
    },
    quarantineCategory: { type: String, default: null },
    reasonCode: { type: String, default: null, maxlength: 200 },
    attempts: { type: Number, default: 0 },
    nextAttemptAt: { type: Date, default: null },
    processingStartedAt: { type: Date, default: null },
    processingLeaseToken: { type: String, default: null },
    processingLeaseExpiresAt: { type: Date, default: null },
  },
  { timestamps: true }
);

MpesaIngestionEventSchema.index({ state: 1, nextAttemptAt: 1, receivedAt: 1 });
MpesaIngestionEventSchema.index({ merchantProfileId: 1, sourceChannel: 1, receivedAt: -1 });
// Non-unique diagnostic index only
MpesaIngestionEventSchema.index({
  provider: 1,
  businessShortCode: 1,
  sourceChannel: 1,
  payloadDigest: 1,
});

export const MpesaIngestionEvent = mongoose.model(
  'MpesaIngestionEvent',
  MpesaIngestionEventSchema
);
