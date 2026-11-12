// G4: encrypted provider credentials, stored separately from BankConnection.
// The opaque credentialsRef is the MongoDB _id, so Mongo's built-in _id
// index enforces uniqueness without a separate index migration.

import mongoose from 'mongoose';
import { BANK_CONNECTION_PROVIDERS } from './BankConnection.js';

const { Schema } = mongoose;

const BankCredentialEnvelopeSchema = new Schema(
  {
    format: {
      type: String,
      required: true,
      enum: ['tycoon-bank-credential'],
    },
    formatVersion: {
      type: Number,
      required: true,
      enum: [1],
    },
    algorithm: {
      type: String,
      required: true,
      enum: ['aes-256-gcm'],
    },
    keyId: {
      type: String,
      required: true,
      match: /^[0-9a-f]{16}$/,
    },
    iv: {
      type: String,
      required: true,
      match: /^[0-9a-f]{24}$/,
    },
    authTag: {
      type: String,
      required: true,
      match: /^[0-9a-f]{32}$/,
    },
    ciphertext: {
      type: String,
      required: true,
      validate: {
        validator(value) {
          if (
            typeof value !== 'string' ||
            value.length === 0 ||
            !/^[A-Za-z0-9+/]+={0,2}$/.test(value)
          ) {
            return false;
          }

          const unpadded = value.replace(/=+$/, '');
          if (unpadded.length % 4 === 1) return false;
          if (value.includes('=') && value.length % 4 !== 0) return false;

          const decoded = Buffer.from(value, 'base64');
          return decoded.length > 0
            && decoded.toString('base64').replace(/=+$/, '') === unpadded;
        },
        message: 'ciphertext must be canonical Base64',
      },
    },
  },
  { _id: false, strict: 'throw' }
);

const BankCredentialSchema = new Schema(
  {
    // Same opaque reference stored on BankConnection.credentialsRef.
    _id: {
      type: String,
      required: true,
      minlength: 1,
      maxlength: 512,
    },
    clientId: {
      type: Schema.Types.ObjectId,
      ref: 'Client',
      required: true,
      immutable: true,
    },
    provider: {
      type: String,
      enum: BANK_CONNECTION_PROVIDERS,
      required: true,
      immutable: true,
    },
    credentialVersion: {
      type: Number,
      required: true,
      min: 1,
      immutable: true,
      validate: {
        validator: Number.isSafeInteger,
        message: 'credentialVersion must be a safe integer >= 1',
      },
    },
    envelope: {
      type: BankCredentialEnvelopeSchema,
      required: true,
      immutable: true,
    },
  },
  {
    collection: 'bankcredentials',
    timestamps: { createdAt: true, updatedAt: false },
    versionKey: false,
    autoIndex: false,
    strict: 'throw',
  }
);

// This model must never be returned as an API response.
BankCredentialSchema.set('toJSON', {
  transform: (_doc, ret) => {
    delete ret._id;
    delete ret.envelope;
    return ret;
  },
});

export const BankCredential = mongoose.model(
  'BankCredential',
  BankCredentialSchema
);
