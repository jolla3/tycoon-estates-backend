// src/models/MpesaMerchantProfile.js
//
// G5.3 — Merchant/shortcode configuration for Buy Goods ingestion.
// Credential material is NOT stored here (B09). Operational flags are evidence-backed.
// autoIndex: false — unique index is migration-controlled only.

import mongoose from 'mongoose';

const { Schema } = mongoose;

const MpesaMerchantProfileSchema = new Schema(
  {
    clientId: { type: Schema.Types.ObjectId, ref: 'Client', required: true, index: true },
    provider: { type: String, required: true, default: 'SAFARICOM', enum: ['SAFARICOM'] },
    merchantType: {
      type: String,
      required: true,
      default: 'BUY_GOODS_TILL',
      enum: ['PAYBILL', 'BUY_GOODS_TILL'],
    },
    displayName: { type: String, default: null },
    businessShortCode: { type: String, required: true },
    // DEPRECATED legacy single-estate association. Not authoritative: the active
    // MpesaMerchantProfileEstate mappings decide estate authorization. Kept until the
    // backfill migration is verified; never read for authorization.
    estateId: { type: Schema.Types.ObjectId, ref: 'Estate', default: null },
    callbackCapability: {
      type: String,
      enum: ['UNKNOWN', 'NOT_ENABLED', 'VERIFIED'],
      default: 'UNKNOWN',
    },
    pullCapability: {
      type: String,
      enum: ['UNKNOWN', 'NOT_ENABLED', 'VERIFIED'],
      default: 'UNKNOWN',
    },
    operationalState: {
      type: String,
      enum: ['DRAFT', 'NOT_READY', 'ACTIVE', 'SUSPENDED'],
      default: 'DRAFT',
      index: true,
    },
    // Optimistic-concurrency token for lifecycle operations (activate/suspend/resume). Missing on
    // legacy documents; treated as 0. Incremented only by the lifecycle service.
    lifecycleRevision: { type: Number, default: 0, min: 0 },
    // Evidence of the last explicit Superadmin lifecycle action. Registration never writes this.
    lifecycle: {
      type: new Schema({
        activatedAt: { type: Date, default: null },
        activatedByUserId: { type: Schema.Types.ObjectId, ref: 'User', default: null },
        suspendedAt: { type: Date, default: null },
        suspendedByUserId: { type: Schema.Types.ObjectId, ref: 'User', default: null },
        suspensionReason: { type: String, default: null },
        resumedAt: { type: Date, default: null },
        resumedByUserId: { type: Schema.Types.ObjectId, ref: 'User', default: null },
      }, { _id: false }),
      default: () => ({}),
    },
    c2bRegistrationState: {
      type: String,
      enum: ['NONE', 'REQUESTED', 'ACCEPTED', 'ALREADY_REGISTERED', 'REJECTED', 'UNCERTAIN'],
      default: 'NONE',
    },
    pullRegistrationState: {
      type: String,
      enum: ['NONE', 'REQUESTED', 'ACCEPTED', 'ALREADY_REGISTERED', 'REJECTED', 'UNCERTAIN'],
      default: 'NONE',
    },
    // Registration evidence (no secrets). Written only by the explicit registration service.
    c2bRegistration: {
      type: new Schema({
        environment: { type: String, default: null },
        configId: { type: String, default: null },
        configVersion: { type: String, default: null },
        confirmationUrl: { type: String, default: null },
        validationUrl: { type: String, default: null },
        responseType: { type: String, default: null },
        attemptedAt: { type: Date, default: null },
        succeededAt: { type: Date, default: null },
        providerResponseCode: { type: String, default: null },
        providerConversationId: { type: String, default: null },
      }, { _id: false }),
      default: () => ({}),
    },
    pullRegistration: {
      type: new Schema({
        environment: { type: String, default: null },
        configId: { type: String, default: null },
        configVersion: { type: String, default: null },
        callbackUrl: { type: String, default: null },
        attemptedAt: { type: Date, default: null },
        succeededAt: { type: Date, default: null },
        providerResponseStatus: { type: String, default: null },
      }, { _id: false }),
      default: () => ({}),
    },
    // Merchant-KYC nominated MSISDN for Pull registration. Encrypted at rest; never
    // returned by any API; only the registration service decrypts it.
    pullNominatedMsisdnEncrypted: { type: String, default: null, select: false },
    pullNominatedMsisdnMasked: { type: String, default: null },
    pullNominatedMsisdnSetAt: { type: Date, default: null },
    lastC2bRegisteredAt: { type: Date, default: null },
    lastPullRegisteredAt: { type: Date, default: null },
    createdByUserId: { type: Schema.Types.ObjectId, ref: 'User', default: null },
    updatedByUserId: { type: Schema.Types.ObjectId, ref: 'User', default: null },
  },
  { timestamps: true, autoIndex: false, collection: 'mpesamerchantprofiles' }
);

/**
 * One owner per shortcode per provider. DARAJA_ENVIRONMENT is process-wide and one
 * deployment uses one database, so no environment key is part of the index.
 * Migration-controlled only; autoIndex: false so boot never installs it.
 */
MpesaMerchantProfileSchema.index(
  { provider: 1, businessShortCode: 1 },
  { unique: true, name: 'uniq_provider_business_shortcode' }
);
// Legacy per-client index (superseded by the global ownership index above). It is no
// longer required by readiness and is dropped only by an explicit, verified migration step.
MpesaMerchantProfileSchema.index(
  { clientId: 1, businessShortCode: 1 },
  { unique: true, name: 'uniq_client_business_shortcode' }
);
MpesaMerchantProfileSchema.index({ clientId: 1, operationalState: 1 });

export const MpesaMerchantProfile = mongoose.model(
  'MpesaMerchantProfile',
  MpesaMerchantProfileSchema
);
