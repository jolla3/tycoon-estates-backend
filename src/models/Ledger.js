// src/models/Ledger.js
//
// Authoritative financial movement for a house/tenant account.
// RentCharge = what was billed (billing record).
// Payment / PaymentAllocation = receipt + allocation records.
// Ledger = source of truth for running account balance.
//
// amountCents convention:
//   positive = credit to tenant account (payment / reduces amount owed)
//   negative = debit  (charge / increases amount owed)
// runningBalanceCents = amount still owed after this entry (positive = debt).

import mongoose from 'mongoose';
const { Schema } = mongoose;

const ENTRY_TYPES = [
  'PAYMENT',
  'SETTLEMENT',
  'MANUAL_ADJUSTMENT',
  'BONUS',
  'PENALTY',
  'LOAN',
  'INTEREST',
  'REVERSAL',
  'CHARGE',
  'DEPOSIT_RECEIVED',
  'DEPOSIT_DEDUCTION',
  'DEPOSIT_REFUND',
];

const LedgerSchema = new Schema(
  {
    clientId: { type: Schema.Types.ObjectId, ref: 'Client', required: true, index: true },
    estateId: { type: Schema.Types.ObjectId, ref: 'Estate', required: true, index: true },
    houseId: { type: Schema.Types.ObjectId, ref: 'House', required: true, index: true },
    tenantId: { type: Schema.Types.ObjectId, ref: 'Tenant' },
    entryType: {
      type: String,
      enum: ENTRY_TYPES,
      required: true,
    },
    // Signed cents: + credit (payment), - debit (charge)
    amountCents: { type: Number, required: true },
    // Amount still owed after this entry (positive = tenant owes)
    runningBalanceCents: { type: Number, required: true },
    // Idempotency / audit link
    referenceType: {
      type: String,
      enum: ['Payment', 'RentCharge', 'BankTransaction', 'Manual', 'Deposit', null],
      default: null,
    },
    referenceId: { type: Schema.Types.ObjectId, default: null },
    description: { type: String, default: '' },
    period: String, // YYYY-MM when applicable
  },
  { timestamps: true }
);

// One ledger row per financial event reference (prevents duplicate PAYMENT posts)
LedgerSchema.index(
  { clientId: 1, referenceType: 1, referenceId: 1, entryType: 1 },
  {
    unique: true,
    partialFilterExpression: { referenceId: { $type: 'objectId' } },
  }
);
LedgerSchema.index({ clientId: 1, houseId: 1, createdAt: -1 });
LedgerSchema.index({ clientId: 1, tenantId: 1, createdAt: -1 });
LedgerSchema.index({ estateId: 1, createdAt: -1 });

export const Ledger = mongoose.model('Ledger', LedgerSchema);
export const LEDGER_ENTRY_TYPES = ENTRY_TYPES;
