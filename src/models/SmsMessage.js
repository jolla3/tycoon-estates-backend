// src/models/SmsMessage.js
import mongoose from 'mongoose';
const { Schema } = mongoose;

const SmsMessageSchema = new Schema(
  {
    clientId: { type: Schema.Types.ObjectId, ref: 'Client', required: true, index: true },
    estateId: { type: Schema.Types.ObjectId, ref: 'Estate', required: true, index: true },
    tenantId: { type: Schema.Types.ObjectId, ref: 'Tenant' },
    houseId: { type: Schema.Types.ObjectId, ref: 'House' },
    phoneNumber: { type: String, required: true },
    message: { type: String, required: true },
    provider: { type: String, default: 'celcom' },
    type: {
      type: String,
      enum: [
        'rent_reminder',
        'payment_confirmation',
        'arrears_notice',
        'billing_notification',
        'broadcast',
        'general',
      ],
      default: 'general',
    },
    // e.g. billing_notification:v1 — persisted so historical records stay unambiguous
    notificationVersion: { type: String, default: null, index: true },
    // Shared id for all per-recipient jobs created by one broadcast request
    broadcastId: { type: String, default: null, index: true },
    period: { type: String, default: null }, // YYYY-MM when applicable
    priority: { type: Number, default: 0 },
    status: {
      type: String,
      enum: ['queued', 'processing', 'sent', 'failed', 'unknown'],
      default: 'queued',
      index: true,
    },
    providerMessageId: { type: String, default: null },
    idempotencyKey: { type: String, required: true, unique: true },
    retryCount: { type: Number, default: 0 },
    maxRetries: { type: Number, default: 3 },
    nextRetryAt: Date,
    processingStartedAt: Date,
    sentAt: Date,
    failedAt: Date,
    failureReason: String,
  },
  { timestamps: true }
);

SmsMessageSchema.index({ estateId: 1, houseId: 1, createdAt: -1 });
SmsMessageSchema.index({ clientId: 1, status: 1 });
SmsMessageSchema.index({ clientId: 1, broadcastId: 1 });
SmsMessageSchema.index({ clientId: 1, tenantId: 1, type: 1, period: 1, notificationVersion: 1 });

export const SmsMessage = mongoose.model('SmsMessage', SmsMessageSchema);

export const NOTIFICATION_VERSIONS = {
  billing_notification: 'billing_notification:v1',
  rent_reminder: 'rent_reminder:v1',
  arrears_notice: 'arrears_notice:v1',
  payment_confirmation: 'payment_confirmation:v1',
  broadcast: 'broadcast:v1',
};
