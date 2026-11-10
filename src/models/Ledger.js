// src/models/Ledger.js
import mongoose from 'mongoose';
const { Schema } = mongoose;

const ENTRY_TYPES = [
  'PAYMENT', 'SETTLEMENT', 'MANUAL_ADJUSTMENT', 'BONUS', 'PENALTY', 'LOAN', 'INTEREST',
  'REVERSAL', 'CHARGE', 'DEPOSIT_RECEIVED', 'DEPOSIT_DEDUCTION', 'DEPOSIT_REFUND',
  'DEPOSIT_TRANSFER_OUT', 'DEPOSIT_TRANSFER_IN',
];
const ACCOUNT_CATEGORIES = ['RENT', 'DEPOSIT'];

const LedgerSchema = new Schema(
  {
    clientId: { type: Schema.Types.ObjectId, ref: 'Client', required: true, index: true },
    estateId: { type: Schema.Types.ObjectId, ref: 'Estate', required: true, index: true },
    houseId: { type: Schema.Types.ObjectId, ref: 'House', required: true, index: true },
    tenantId: { type: Schema.Types.ObjectId, ref: 'Tenant' },
    tenancyId: { type: Schema.Types.ObjectId, ref: 'Tenancy', default: null, index: true },
    accountCategory: { type: String, enum: ACCOUNT_CATEGORIES, default: 'RENT', required: true },
    entryType: { type: String, enum: ENTRY_TYPES, required: true },
    amountCents: { type: Number, required: true },
    runningBalanceCents: { type: Number, required: true },
    referenceType: {
      type: String,
      enum: ['Payment', 'RentCharge', 'BankTransaction', 'Manual', 'Deposit', 'DepositMovement', null],
      default: null,
    },
    referenceId: { type: Schema.Types.ObjectId, default: null },
    description: { type: String, default: '' },
    period: String,
  },
  { timestamps: true }
);

LedgerSchema.index(
  { clientId: 1, referenceType: 1, referenceId: 1, entryType: 1 },
  { unique: true, partialFilterExpression: { referenceId: { $type: 'objectId' } } }
);
LedgerSchema.index({ clientId: 1, tenancyId: 1, accountCategory: 1, createdAt: -1 });
LedgerSchema.index({ clientId: 1, houseId: 1, createdAt: -1 });
LedgerSchema.index({ clientId: 1, tenantId: 1, createdAt: -1 });
LedgerSchema.index({ estateId: 1, createdAt: -1 });

export const Ledger = mongoose.model('Ledger', LedgerSchema);
export const LEDGER_ENTRY_TYPES = ENTRY_TYPES;
export const LEDGER_ACCOUNT_CATEGORIES = ACCOUNT_CATEGORIES;
