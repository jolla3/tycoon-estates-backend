// src/models/BankAccount.js
//
// Customer configuration, not application configuration (section 5/36).
// accountNumberEncrypted is AES-256-GCM ciphertext — see utils/encryption.js.
import mongoose from 'mongoose';
const { Schema } = mongoose;

const BankAccountSchema = new Schema(
  {
    clientId: { type: Schema.Types.ObjectId, ref: 'Client', required: true, index: true },
    estateId: { type: Schema.Types.ObjectId, ref: 'Estate', required: true, index: true },
    provider: { type: String, enum: ['COOP', 'KCB', 'EQUITY', 'NCBA'], required: true },
    accountNumberEncrypted: { type: String, required: true },
    // Deterministic HMAC of the account number (utils/encryption.js#hashForLookup).
    // AES-256-GCM ciphertext uses a random IV per encryption, so
    // accountNumberEncrypted itself can never be queried by value — this
    // is what lets the webhook resolve "which estate does this account
    // number belong to" without decrypting every BankAccount to check.
    accountNumberHash: { type: String, required: true, index: true },
    accountName: { type: String, required: true },
    currency: { type: String, default: 'KES' },
    connectionStatus: { type: String, enum: ['pending', 'connected', 'failed'], default: 'pending' },
    lastSyncedAt: Date,
  },
  { timestamps: true }
);

BankAccountSchema.index({ estateId: 1, provider: 1 });
BankAccountSchema.index({ clientId: 1, provider: 1 });
// The lookup path the webhook actually uses (section 16 fix).
BankAccountSchema.index({ provider: 1, accountNumberHash: 1 }, { unique: true });

BankAccountSchema.set('toJSON', {
  transform: (_doc, ret) => {
    delete ret.accountNumberEncrypted;
    delete ret.accountNumberHash;
    return ret;
  },
});

// lean() responses bypass toJSON — callers that use .lean() must still
// strip these fields explicitly (bank.service list helpers do).
export function sanitizeBankAccount(doc) {
  if (!doc) return doc;
  const obj = typeof doc.toObject === 'function' ? doc.toObject() : { ...doc };
  delete obj.accountNumberEncrypted;
  delete obj.accountNumberHash;
  return obj;
}

export const BankAccount = mongoose.model('BankAccount', BankAccountSchema);
