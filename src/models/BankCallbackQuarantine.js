// src/models/BankCallbackQuarantine.js
//
// Durable quarantine for authenticated callbacks that cannot safely enter
// normal ingestion. Does not store credentials, tokens, or auth headers.

import mongoose from 'mongoose';

const { Schema } = mongoose;

export const QUARANTINE_CATEGORIES = Object.freeze([
  'malformed_payload',
  'invalid_direction',
  'missing_identity',
  'unknown_account',
  'ownership_conflict',
  'validation_failed',
  'ingestion_error',
  'provider_capability',
  'other',
]);

export const QUARANTINE_STATUSES = Object.freeze([
  'open',
  'resolved',
  'rejected',
]);

const BankCallbackQuarantineSchema = new Schema(
  {
    provider: { type: String, required: true, index: true },
    clientId: { type: Schema.Types.ObjectId, ref: 'Client', default: null, index: true },
    estateId: { type: Schema.Types.ObjectId, ref: 'Estate', default: null },
    bankAccountId: { type: Schema.Types.ObjectId, ref: 'BankAccount', default: null },
    connectionId: { type: Schema.Types.ObjectId, ref: 'BankConnection', default: null },
    receivedAt: { type: Date, required: true, default: Date.now, index: true },
    category: { type: String, enum: QUARANTINE_CATEGORIES, required: true },
    reason: { type: String, required: true, maxlength: 500 },
    /** SHA-256 hex digest of canonicalized payload body (no secrets). */
    payloadDigest: { type: String, required: true, index: true },
    /** Redacted subset of non-secret fields for investigation. */
    payloadRedacted: { type: Schema.Types.Mixed, default: null },
    providerTransactionId: { type: String, default: null, index: true },
    status: { type: String, enum: QUARANTINE_STATUSES, default: 'open', index: true },
    sourceChannel: { type: String, default: 'webhook' },
  },
  { timestamps: true }
);

BankCallbackQuarantineSchema.index({ provider: 1, payloadDigest: 1, status: 1 });

export const BankCallbackQuarantine = mongoose.model(
  'BankCallbackQuarantine',
  BankCallbackQuarantineSchema
);
