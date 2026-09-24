// src/models/Subscription.js
//
// Foundation for future SaaS billing enforcement (section 40). No payment
// processing here on purpose — just enough shape to gate features by plan
// later without a schema migration.
import mongoose from 'mongoose';
const { Schema } = mongoose;

const SubscriptionSchema = new Schema(
  {
    // Billing lives at the Client level, not per-Estate — a client may
    // have several estates but one subscription/plan.
    clientId: { type: Schema.Types.ObjectId, ref: 'Client', required: true, unique: true, index: true },
    plan: { type: String, enum: ['trial', 'basic', 'pro'], default: 'trial' },
    status: { type: String, enum: ['active', 'past_due', 'canceled'], default: 'active' },
    startDate: { type: Date, default: Date.now },
    endDate: Date,
  },
  { timestamps: true }
);

export const Subscription = mongoose.model('Subscription', SubscriptionSchema);
