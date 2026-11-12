// src/models/BankAccount.js
//
// Customer configuration, not application configuration.
// accountNumberEncrypted is AES-256-GCM ciphertext — see utils/encryption.js.
// G4 Batch 02: connection association, validation state, entitlements.
// Physical identity remains unique { provider, accountNumberHash }.

import mongoose from 'mongoose';
const { Schema } = mongoose;

export const BANK_ACCOUNT_VALIDATION_STATUSES = Object.freeze([
  'pending',
  'validated',
  'failed',
  'unavailable',
]);

/** Account-level capability flags (not connection auth state). */
const EntitlementsSchema = new Schema(
  {
    poll: { type: Boolean, default: false },
    statement: { type: Boolean, default: false },
    balance: { type: Boolean, default: false },
    webhookIngest: { type: Boolean, default: false },
  },
  { _id: false }
);

const BankAccountSchema = new Schema(
  {
    clientId: { type: Schema.Types.ObjectId, ref: 'Client', required: true, index: true },
    estateId: { type: Schema.Types.ObjectId, ref: 'Estate', required: true, index: true },
    /**
     * Owning API connection. Required for new G4-managed accounts.
     * Legacy rows may be null until an explicit backfill migration.
     */
    connectionId: {
      type: Schema.Types.ObjectId,
      ref: 'BankConnection',
      default: null,
      index: true,
    },
    provider: { type: String, enum: ['COOP', 'KCB', 'EQUITY', 'NCBA'], required: true },
    accountNumberEncrypted: { type: String, required: true },
    // Deterministic HMAC of the account number (utils/encryption.js#hashForLookup).
    accountNumberHash: { type: String, required: true, index: true },
    accountName: { type: String, required: true },
    currency: { type: String, default: 'KES' },
    /**
     * Account activation / link status — not BankConnection.status.
     * Fail-closed: only 'connected' after successful validation.
     */
    connectionStatus: {
      type: String,
      enum: ['pending', 'connected', 'failed'],
      default: 'pending',
    },
    validationStatus: {
      type: String,
      enum: BANK_ACCOUNT_VALIDATION_STATUSES,
      default: 'pending',
    },
    lastValidatedAt: { type: Date, default: null },
    entitlements: {
      type: EntitlementsSchema,
      default: () => ({
        poll: false,
        statement: false,
        balance: false,
        webhookIngest: false,
      }),
    },
    lastSyncedAt: Date,
    /**
     * Embedded sync coordination (G4 Batch 04).
     * Checkpoint = highest position durably accepted by ingestion.
     * fenceGeneration increments on each lease acquire; stale workers cannot advance checkpoints.
     */
    sync: {
      status: {
        type: String,
        enum: ['idle', 'running', 'success', 'failed'],
        default: 'idle',
      },
      fenceGeneration: { type: Number, default: 0, min: 0 },
      leaseOwner: { type: String, default: null },
      leaseExpiresAt: { type: Date, default: null },
      checkpoint: {
        type: { type: String, enum: ['none', 'date_window', 'opaque_cursor', 'page'], default: 'none' },
        value: { type: Schema.Types.Mixed, default: null },
        acceptedThrough: { type: Date, default: null },
      },
      lastAttemptAt: { type: Date, default: null },
      lastSuccessAt: { type: Date, default: null },
      lastError: { type: String, default: null },
      lastErrorCategory: { type: String, default: null },
    },
  },
  { timestamps: true }
);

BankAccountSchema.index({ estateId: 1, provider: 1 });
BankAccountSchema.index({ clientId: 1, provider: 1 });
// Global physical-account identity — one row per provider + account number.
BankAccountSchema.index({ provider: 1, accountNumberHash: 1 }, { unique: true });
BankAccountSchema.index({ clientId: 1, connectionId: 1 });

BankAccountSchema.set('toJSON', {
  transform: (_doc, ret) => {
    delete ret.accountNumberEncrypted;
    delete ret.accountNumberHash;
    return ret;
  },
});

export function sanitizeBankAccount(doc) {
  if (!doc) return doc;
  const obj = typeof doc.toObject === 'function' ? doc.toObject() : { ...doc };
  delete obj.accountNumberEncrypted;
  delete obj.accountNumberHash;
  return obj;
}

export const BankAccount = mongoose.model('BankAccount', BankAccountSchema);
