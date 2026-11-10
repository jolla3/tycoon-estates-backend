// src/models/HouseType.js
// Client-scoped unit classification. G3: authoritative shared recurring billing plan.
import mongoose from 'mongoose';
const { Schema } = mongoose;

const DefaultBillingLineSchema = new Schema(
  {
    // Stable line id within a plan version (optional; identity for charges still uses chargeType+description)
    lineId: { type: String, default: null },
    chargeType: {
      type: String,
      enum: ['RENT', 'WATER', 'ELECTRICITY', 'OTHER'],
      required: true,
    },
    description: { type: String, default: '' },
    amountCents: { type: Number, required: true, min: 0 },
    dueDay: { type: Number, min: 1, max: 31 },
  },
  { _id: false }
);

const HouseTypeSchema = new Schema(
  {
    clientId: { type: Schema.Types.ObjectId, ref: 'Client', required: true, index: true },
    estateId: { type: Schema.Types.ObjectId, ref: 'Estate', required: true, index: true },
    name: { type: String, required: true, trim: true },
    description: { type: String, default: '' },
    defaultRentCents: { type: Number, default: 0, min: 0 },
    defaultDueDay: { type: Number, min: 1, max: 31 },
    // Authoritative recurring lines for this type (shared by all houses of the type).
    // Edits bump planVersion; historical RentCharges keep their snapshots.
    defaultBilling: { type: [DefaultBillingLineSchema], default: [] },
    // Monotonic plan version; incremented when defaultBilling / defaultRentCents / defaultDueDay change.
    planVersion: { type: Number, default: 1, min: 1 },
    // One shared non-monetary write point. Plan edits and charge generation
    // must update the same path inside their transactions to prevent write skew.
    billingPlanRev: { type: Number, default: 0, min: 0 },
    isActive: { type: Boolean, default: true },
  },
  { timestamps: true, autoIndex: false }
);

HouseTypeSchema.index(
  { clientId: 1, estateId: 1, name: 1 },
  { unique: true, collation: { locale: 'en', strength: 2 } }
);

export const HouseType = mongoose.model('HouseType', HouseTypeSchema);

/** Reject duplicate (chargeType, description) within one plan. */
export function assertUniquePlanLines(lines) {
  const seen = new Set();
  for (const line of lines || []) {
    const key = `${String(line.chargeType || '').toUpperCase()}::${String(line.description || '').trim().toLocaleLowerCase('en')}`;
    if (seen.has(key)) {
      const err = new Error(
        `Duplicate HouseType plan line for (${line.chargeType}, "${line.description || ''}"). `
          + 'Each (chargeType, description) must be unique within a plan version.'
      );
      err.code = 'DUPLICATE_PLAN_LINE';
      throw err;
    }
    seen.add(key);
  }
}
