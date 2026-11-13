// src/models/MpesaSubmissionLink.js
//
// G5 — ONE private payment-submission link identity per { clientId, estateId, tenantId }.
// Rotation/revocation change the secret digest, never the Tenant identity.
// `linkVersion` is a non-monetary CAS token: submissions read it and later write
// conditioned on it, so a rotate/revoke between read and write defeats the submission.
// The raw bearer token is NEVER persisted — only a keyed HMAC digest.
// autoIndex:false — unique identity is migration-controlled.

import mongoose from 'mongoose';

const { Schema } = mongoose;

const MpesaSubmissionLinkSchema = new Schema(
  {
    clientId: { type: Schema.Types.ObjectId, ref: 'Client', required: true },
    estateId: { type: Schema.Types.ObjectId, ref: 'Estate', required: true },
    tenantId: { type: Schema.Types.ObjectId, ref: 'Tenant', required: true },
    merchantProfileId: { type: Schema.Types.ObjectId, ref: 'MpesaMerchantProfile', default: null },
    status: { type: String, enum: ['ACTIVE', 'REVOKED'], default: 'ACTIVE' },
    tokenDigest: { type: String, default: null, select: false },
    linkVersion: { type: Number, default: 1, min: 1 },
    rotatedAt: { type: Date, default: null },
    revokedAt: { type: Date, default: null },
    createdByUserId: { type: Schema.Types.ObjectId, ref: 'User', default: null },
    lastRotatedByUserId: { type: Schema.Types.ObjectId, ref: 'User', default: null },
  },
  { timestamps: true, autoIndex: false, collection: 'mpesasubmissionlinks' }
);

export const SUBMISSION_LINK_INDEXES = Object.freeze({
  IDENTITY: { name: 'uniq_g5_link_tenant', key: { clientId: 1, estateId: 1, tenantId: 1 }, unique: true },
  DIGEST: {
    name: 'uniq_g5_link_token_digest',
    key: { tokenDigest: 1 },
    unique: true,
    partialFilterExpression: { tokenDigest: { $type: 'string' } },
  },
});

MpesaSubmissionLinkSchema.index(
  SUBMISSION_LINK_INDEXES.IDENTITY.key,
  { unique: true, name: SUBMISSION_LINK_INDEXES.IDENTITY.name }
);
MpesaSubmissionLinkSchema.index(
  SUBMISSION_LINK_INDEXES.DIGEST.key,
  {
    unique: true,
    name: SUBMISSION_LINK_INDEXES.DIGEST.name,
    partialFilterExpression: SUBMISSION_LINK_INDEXES.DIGEST.partialFilterExpression,
  }
);

export const MpesaSubmissionLink = mongoose.model('MpesaSubmissionLink', MpesaSubmissionLinkSchema);
