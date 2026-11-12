// src/models/BankConnection.js
//
// G4 Task 01: one independent banking API connection owned by one Tycoon
// client for one provider. Customer secret material lives in a secrets
// manager; this document stores only a reference and version metadata.
//
// Connection authentication state (status / authMeta) is intentionally
// separate from BankAccount validation, entitlements, and callback
// subscription state (those remain on or about BankAccount in later tasks).

import mongoose from 'mongoose';

const { Schema } = mongoose;

/** Existing provider identifiers — presence here is not an operational claim. */
export const BANK_CONNECTION_PROVIDERS = Object.freeze(['COOP', 'KCB', 'EQUITY', 'NCBA']);

/**
 * Connection-level authentication / lifecycle state.
 * Must not be used as a substitute for account validation or entitlements.
 */
export const BANK_CONNECTION_STATUSES = Object.freeze([
  'pending',
  'active',
  'reauth_required',
  'disconnected',
  'failed',
]);

const AuthMetaSchema = new Schema(
  {
    /** Cached expiry hint for operational display — not a stored token. */
    tokenExpiresAt: { type: Date, default: null },
    lastAuthAt: { type: Date, default: null },
    lastAuthError: { type: String, default: null },
    /** Non-secret external client/application identifier if the provider exposes one. */
    externalClientId: { type: String, default: null },
  },
  { _id: false }
);

const BankConnectionSchema = new Schema(
  {
    clientId: {
      type: Schema.Types.ObjectId,
      ref: 'Client',
      required: true,
      index: true,
    },
    provider: {
      type: String,
      enum: BANK_CONNECTION_PROVIDERS,
      required: true,
    },
    displayName: {
      type: String,
      default: null,
      maxlength: 120,
    },
    status: {
      type: String,
      enum: BANK_CONNECTION_STATUSES,
      required: true,
      default: 'pending',
    },
    /**
     * Secrets-manager reference only. Never store API client secrets,
     * resource-owner passwords, access tokens, or refresh tokens here.
     */
    credentialsRef: {
      type: String,
      required: true,
      trim: true,
      minlength: 1,
      maxlength: 512,
    },
    /**
     * Monotonic credential generation. Bump on rotation so token caches
     * keyed by (connectionId, credentialVersion) invalidate correctly.
     */
    credentialVersion: {
      type: Number,
      required: true,
      default: 1,
      min: 1,
      validate: {
        validator: Number.isInteger,
        message: 'credentialVersion must be an integer >= 1',
      },
    },
    authMeta: {
      type: AuthMetaSchema,
      default: () => ({}),
    },
    createdByUserId: {
      type: Schema.Types.ObjectId,
      ref: 'User',
      default: null,
    },
    updatedByUserId: {
      type: Schema.Types.ObjectId,
      ref: 'User',
      default: null,
    },
  },
  { timestamps: true }
);

// Non-unique: multiple independent connections per client+provider are allowed.
// Connection identity is the document _id, not { clientId, provider }.
BankConnectionSchema.index({ clientId: 1, provider: 1, status: 1 });
BankConnectionSchema.index({ clientId: 1, createdAt: -1 });

BankConnectionSchema.set('toJSON', {
  transform: (_doc, ret) => {
    // credentialsRef is not a secret payload but is still operationally sensitive.
    delete ret.credentialsRef;
    return ret;
  },
});

/**
 * Public/API-safe shape. lean() bypasses toJSON — callers using lean() must
 * use this helper (same pattern as sanitizeBankAccount).
 */
export function sanitizeBankConnection(doc) {
  if (!doc) return doc;
  const obj = typeof doc.toObject === 'function' ? doc.toObject() : { ...doc };
  delete obj.credentialsRef;
  return obj;
}

/**
 * Index specifications owned by this model (for tests and explicit migrations).
 * Not applied destructively at process startup.
 */
export const BANK_CONNECTION_INDEX_SPECS = Object.freeze([
  {
    name: 'bankconnection_client_provider_status',
    key: { clientId: 1, provider: 1, status: 1 },
    unique: false,
  },
  {
    name: 'bankconnection_client_createdAt',
    key: { clientId: 1, createdAt: -1 },
    unique: false,
  },
]);

export const BankConnection = mongoose.model('BankConnection', BankConnectionSchema);
