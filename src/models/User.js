// src/models/User.js
import mongoose from 'mongoose';
const { Schema } = mongoose;

const UserSchema = new Schema(
  {
    name: { type: String, required: true },
    email: { type: String, required: true, unique: true, lowercase: true, trim: true },
    phone: String,
    passwordHash: { type: String, required: true },
    // SUPER_ADMIN is platform-level and has no clientId. Every other role
    // belongs to exactly one Client (section 6/7 of the V2 brief).
    role: { type: String, enum: ['SUPER_ADMIN', 'CLIENT_OWNER', 'CLIENT_ADMIN', 'STAFF'], default: 'STAFF' },
    clientId: {
      type: Schema.Types.ObjectId,
      ref: 'Client',
      required: function requiredUnlessSuperAdmin() { return this.role !== 'SUPER_ADMIN'; },
      index: true,
    },
    // Optional finer-grained restriction to specific estates WITHIN the
    // user's client. Empty array == full access to every estate under
    // their client (the common case for CLIENT_OWNER/CLIENT_ADMIN).
    estateIds: [{ type: Schema.Types.ObjectId, ref: 'Estate' }],
    isActive: { type: Boolean, default: true },
    lastLoginAt: Date,
  },
  { timestamps: true }
);

UserSchema.index({ clientId: 1, email: 1 });

UserSchema.set('toJSON', {
  transform: (_doc, ret) => {
    delete ret.passwordHash;
    return ret;
  },
});

export const User = mongoose.model('User', UserSchema);
