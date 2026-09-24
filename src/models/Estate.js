// src/models/Estate.js
import mongoose from 'mongoose';
import { BUSINESS_TZ } from '../utils/date.js';
const { Schema } = mongoose;

const EstateSchema = new Schema(
  {
    clientId: { type: Schema.Types.ObjectId, ref: 'Client', required: true, index: true },
    name: { type: String, required: true },
    address: String,
    currency: { type: String, default: 'KES' },
    timezone: { type: String, default: BUSINESS_TZ },
    defaultDueDay: { type: Number, default: 5, min: 1, max: 31 },
    isActive: { type: Boolean, default: true },
  },
  { timestamps: true }
);

export const Estate = mongoose.model('Estate', EstateSchema);
