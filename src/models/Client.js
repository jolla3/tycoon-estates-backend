// src/models/Client.js
//
// Section 1/2 (V2): the root tenant boundary. Every business document
// ultimately belongs to a Client — Estate is a sub-scope WITHIN a client,
// not the tenancy boundary itself (that was V1's mistake).
import mongoose from 'mongoose';
const { Schema } = mongoose;

const ClientSchema = new Schema(
  {
    name: { type: String, required: true },
    isActive: { type: Boolean, default: true },
  },
  { timestamps: true }
);

export const Client = mongoose.model('Client', ClientSchema);
