// src/models/AuditLog.js
//
// Section 24/26 (V2): client-scoped audit trail. clientId is optional
// only for platform-level SUPER_ADMIN actions that have no client
// context (e.g. creating a new Client) — every client-scoped action must
// set it, and every audit query MUST filter by it (see audit.service.js).
import mongoose from 'mongoose';
const { Schema } = mongoose;

const AuditLogSchema = new Schema(
  {
    clientId: { type: Schema.Types.ObjectId, ref: 'Client', default: null, index: true },
    estateId: { type: Schema.Types.ObjectId, ref: 'Estate', default: null },
    userId: { type: Schema.Types.ObjectId, ref: 'User' },
    action: { type: String, required: true },
    resource: String,
    resourceId: String,
    description: String,
    metadata: Schema.Types.Mixed,
    ipAddress: String,
    userAgent: String,
  },
  { timestamps: { createdAt: true, updatedAt: false } }
);

AuditLogSchema.index({ clientId: 1, createdAt: -1 });
AuditLogSchema.index({ clientId: 1, action: 1 });

export const AuditLog = mongoose.model('AuditLog', AuditLogSchema);
