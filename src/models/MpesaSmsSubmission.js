// src/models/MpesaSmsSubmission.js
//
// G5 — a payer-submitted M-PESA confirmation SMS. SUBMITTED evidence only.
// Raw text exists only inside an authenticated-encryption envelope and is never
// selected by default. Allowlisted normalized fields + keyed digest are stored
// separately. Payer identity is NOT recorded or compared to the Tenant.
// autoIndex:false — unique identity is migration-controlled.

import mongoose from 'mongoose';

const { Schema } = mongoose;

export const SUBMISSION_STATE = Object.freeze({
  RECEIVED: 'RECEIVED',
  UNSUPPORTED: 'UNSUPPORTED',        // unparseable / unsupported template
  PARSED: 'PARSED',                  // parsed; awaiting canonical provider receipt
  UNMATCHED: 'UNMATCHED',            // no canonical receipt yet / merchant not matched
  MATCHED: 'MATCHED',                // all evidence agrees; claim/posting may proceed
  CONFLICTING: 'CONFLICTING',        // evidence disagrees or competing claim
  MANUAL_REVIEW: 'MANUAL_REVIEW',
  POSTED: 'POSTED',
  REJECTED: 'REJECTED',
});

const MpesaSmsSubmissionSchema = new Schema(
  {
    clientId: { type: Schema.Types.ObjectId, ref: 'Client', required: true },
    estateId: { type: Schema.Types.ObjectId, ref: 'Estate', required: true },
    tenantId: { type: Schema.Types.ObjectId, ref: 'Tenant', required: true },
    linkId: { type: Schema.Types.ObjectId, ref: 'MpesaSubmissionLink', required: true },
    linkVersion: { type: Number, required: true },
    state: { type: String, enum: Object.values(SUBMISSION_STATE), default: SUBMISSION_STATE.RECEIVED },
    stateReason: { type: String, default: null },

    parserVersion: { type: String, default: null },
    template: { type: String, default: null },
    parseErrors: { type: [String], default: [] },

    // Allowlisted normalized evidence (no payer balance, no payer identity).
    receiptNumber: { type: String, default: null },
    amountCents: { type: Number, default: null },
    currency: { type: String, default: null },
    smsMerchantName: { type: String, default: null },
    smsTransactionAt: { type: Date, default: null },
    timestampSemantics: { type: String, default: null },

    evidenceDigest: { type: String, required: true },
    evidenceEnvelope: { type: String, default: null, select: false },
    evidenceKeyId: { type: String, default: null },
    retentionState: {
      type: String,
      enum: ['RETAINED_ENCRYPTED', 'NOT_RETAINED_POLICY_PENDING'],
      default: 'NOT_RETAINED_POLICY_PENDING',
    },

    mpesaTransactionId: { type: Schema.Types.ObjectId, ref: 'MpesaTransaction', default: null },
    reviewedByUserId: { type: Schema.Types.ObjectId, ref: 'User', default: null },
    reviewReasonCode: { type: String, default: null },
  },
  { timestamps: true, autoIndex: false, collection: 'mpesasmssubmissions' }
);

export const SMS_SUBMISSION_INDEXES = Object.freeze({
  // One submission per (Tenant link, exact evidence). Duplicate pastes collapse.
  EVIDENCE: {
    name: 'uniq_g5_submission_tenant_evidence',
    key: { clientId: 1, estateId: 1, tenantId: 1, evidenceDigest: 1 },
    unique: true,
  },
});
MpesaSmsSubmissionSchema.index(
  SMS_SUBMISSION_INDEXES.EVIDENCE.key,
  { unique: true, name: SMS_SUBMISSION_INDEXES.EVIDENCE.name }
);
MpesaSmsSubmissionSchema.index({ clientId: 1, estateId: 1, state: 1, createdAt: -1 });
MpesaSmsSubmissionSchema.index({ receiptNumber: 1 });
MpesaSmsSubmissionSchema.index({ clientId: 1, tenantId: 1, createdAt: -1 });

export const MpesaSmsSubmission = mongoose.model('MpesaSmsSubmission', MpesaSmsSubmissionSchema);
