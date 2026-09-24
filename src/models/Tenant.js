// src/models/Tenant.js
import mongoose from 'mongoose';
const { Schema } = mongoose;

const TenantSchema = new Schema(
  {
    clientId: { type: Schema.Types.ObjectId, ref: 'Client', required: true, index: true },
    estateId: { type: Schema.Types.ObjectId, ref: 'Estate', required: true, index: true },
    houseId: { type: Schema.Types.ObjectId, ref: 'House', required: true },
    name: { type: String, required: true },
    phone: { type: String, required: true },
    status: { type: String, enum: ['active', 'moved_out'], default: 'active' },
    moveInDate: Date,
    moveOutDate: Date,
  },
  { timestamps: true }
);

TenantSchema.index({ estateId: 1, phone: 1 });
TenantSchema.index({ clientId: 1, createdAt: -1 });

export const Tenant = mongoose.model('Tenant', TenantSchema);
