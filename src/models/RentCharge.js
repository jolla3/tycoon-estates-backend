// Generalized billing charge. G3: financial identity is tenancy-scoped.
// Locked business identity:
// { tenancyId, period, chargeType, description }
//
// Unique enforcement is owned by the explicit migration, not schema
// auto-index creation.

import mongoose from 'mongoose';

const { Schema } = mongoose;

const RentChargeSchema = new Schema(
  {
    clientId: {
      type: Schema.Types.ObjectId,
      ref: 'Client',
      required: true,
      index: true,
    },
    estateId: {
      type: Schema.Types.ObjectId,
      ref: 'Estate',
      required: true,
      index: true,
    },
    houseId: {
      type: Schema.Types.ObjectId,
      ref: 'House',
      required: true,
    },
    tenantId: {
      type: Schema.Types.ObjectId,
      ref: 'Tenant',
    },
    // Nullable only for preserved historical rows. New writers must supply
    // the tenancy ObjectId.
    tenancyId: {
      type: Schema.Types.ObjectId,
      ref: 'Tenancy',
      default: null,
      index: true,
    },
    period: {
      type: String,
      required: true, // YYYY-MM in Nairobi time
    },
    chargeType: {
      type: String,
      enum: ['RENT', 'WATER', 'ELECTRICITY', 'OTHER'],
      default: 'RENT',
      required: true,
    },
    description: {
      type: String,
      default: '',
    },
    amountDueCents: {
      type: Number,
      required: true,
    },
    amountPaidCents: {
      type: Number,
      default: 0,
    },
    balanceCents: {
      type: Number,
      required: true,
    },
    status: {
      type: String,
      enum: ['PAID', 'PARTIAL', 'UNPAID', 'OVERPAID'],
      default: 'UNPAID',
    },
    dueDate: Date,

    // Legacy / optional link to per-house config.
    // Not authoritative under the G3 HouseType plan.
    billingConfigId: {
      type: Schema.Types.ObjectId,
      ref: 'HouseBillingConfig',
      default: null,
    },
    appliedAmountCents: {
      type: Number,
      default: null,
    },

    // G3.2 immutable plan snapshot.
    // Future billing only; never rewrite after insert.
    planId: {
      type: Schema.Types.ObjectId,
      default: null,
    },
    planVersionId: {
      type: Schema.Types.ObjectId,
      ref: 'HouseTypePlanVersion',
      default: null,
    },
    planVersion: {
      type: Number,
      default: null,
    },
    planLineId: {
      type: String,
      default: null,
    },
    billingSource: {
      type: String,
      enum: ['HOUSE_TYPE', 'HOUSE_CONFIG', 'MONTHLY_RENT'],
      default: null,
    },

    // G3.3 non-monetary CAS token for concurrent allocation serialization.
    allocationRev: {
      type: Number,
      default: 0,
    },
  },
  { timestamps: true }
);

// Query indexes only. Financial identity uniqueness is installed by the
// explicit migration after duplicate preflight.
//
// The migration must remove the obsolete house-scoped unique index:
// uniq_house_period_charge_desc.
//
// Do not reintroduce either financial identity index here.
RentChargeSchema.index({ estateId: 1, period: 1, status: 1 });
RentChargeSchema.index({ clientId: 1, period: 1, status: 1 });
RentChargeSchema.index({ houseId: 1, status: 1 });
RentChargeSchema.index({ tenancyId: 1, status: 1 });
RentChargeSchema.index({ houseId: 1, period: 1, chargeType: 1 });
RentChargeSchema.index({ tenancyId: 1, period: 1 });

export const RentCharge = mongoose.model('RentCharge', RentChargeSchema);

/** Canonical names used by migration and readiness inspection. */
export const RENT_CHARGE_INDEX = {
  TARGET_UNIQUE: 'uniq_tenancy_period_charge_desc',
  OBSOLETE_HOUSE_UNIQUE: 'uniq_house_period_charge_desc',
  TARGET_KEYS: {
    tenancyId: 1,
    period: 1,
    chargeType: 1,
    description: 1,
  },
};
