// src/models/Tenancy.js — immutable occupancy (G3)
import mongoose from 'mongoose';
const { Schema } = mongoose;

const TenancySchema = new Schema(
  {
    clientId: { type: Schema.Types.ObjectId, ref: 'Client', required: true, index: true },
    estateId: { type: Schema.Types.ObjectId, ref: 'Estate', required: true, index: true },
    houseId: { type: Schema.Types.ObjectId, ref: 'House', required: true, index: true },
    tenantId: { type: Schema.Types.ObjectId, ref: 'Tenant', required: true, index: true },
    startAt: { type: Date, required: true },
    endAt: { type: Date, default: null },
    status: { type: String, enum: ['ACTIVE', 'CLOSED', 'VOID'], default: 'ACTIVE', required: true },
    // Non-monetary serialization token for tenancy-scoped rent Ledger movements.
    ledgerRev: { type: Number, default: 0, min: 0 },
    closeReason: { type: String, enum: ['MOVE_OUT', 'TRANSFER', 'CORRECTION', null], default: null },
    openedByUserId: { type: Schema.Types.ObjectId, ref: 'User', default: null },
    closedByUserId: { type: Schema.Types.ObjectId, ref: 'User', default: null },
    voidedByUserId: { type: Schema.Types.ObjectId, ref: 'User', default: null },
    voidReason: { type: String, default: null },
  },
  { timestamps: true }
);

TenancySchema.index(
  { houseId: 1 },
  { unique: true, partialFilterExpression: { status: 'ACTIVE' }, name: 'uniq_active_tenancy_per_house' }
);
TenancySchema.index({ tenantId: 1, startAt: -1 });
TenancySchema.index({ clientId: 1, estateId: 1, status: 1 });
TenancySchema.index({ houseId: 1, startAt: 1, endAt: 1 });

export const Tenancy = mongoose.model('Tenancy', TenancySchema);
