// src/models/House.js
import mongoose from 'mongoose';
const { Schema } = mongoose;

const HouseSchema = new Schema(
  {
    clientId: { type: Schema.Types.ObjectId, ref: 'Client', required: true, index: true },
    estateId: { type: Schema.Types.ObjectId, ref: 'Estate', required: true, index: true },
    houseNumber: { type: String, required: true, trim: true },
    // Optional — existing houses may have null until assigned.
    // Historical RentCharges are never rewritten when this changes.
    houseTypeId: { type: Schema.Types.ObjectId, ref: 'HouseType', default: null, index: true },
    // Admin-configurable alternate identifiers a bank transaction's
    // reference/narration might use instead of the exact house number
    // (e.g. a tenant's account number, an old house numbering scheme).
    // Reconciliation tries houseNumber first, then these — never a fuzzy
    // guess beyond an exact, admin-approved string.
    paymentReferences: { type: [String], default: [] },
    tenantId: { type: Schema.Types.ObjectId, ref: 'Tenant', default: null },
    monthlyRent: { type: Number, required: true },
    dueDay: { type: Number, default: 5, min: 1, max: 31 },
    status: { type: String, enum: ['occupied', 'vacant'], default: 'vacant' },
    isActive: { type: Boolean, default: true },
  },
  { timestamps: true }
);

// House number must be unique within an estate, not globally.
HouseSchema.index({ estateId: 1, houseNumber: 1 }, { unique: true });

export const House = mongoose.model('House', HouseSchema);
