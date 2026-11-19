// src/models/MpesaCollectionReference.js
//
// PayBill collection reference -> exactly one merchant + client + estate + tenant + tenancy.
// References are RETIRED, never reassigned: the unique key includes retired rows, so a
// reference can never point at a second tenancy. Historical references keep resolving to
// their original tenant/tenancy for late payments (G3 rules decide posting).
// autoIndex: false — unique indexes are migration-controlled only.

import mongoose from 'mongoose';

const { Schema } = mongoose;

const MpesaCollectionReferenceSchema = new Schema(
  {
    merchantProfileId: { type: Schema.Types.ObjectId, ref: 'MpesaMerchantProfile', required: true },
    clientId: { type: Schema.Types.ObjectId, ref: 'Client', required: true },
    estateId: { type: Schema.Types.ObjectId, ref: 'Estate', required: true },
    tenantId: { type: Schema.Types.ObjectId, ref: 'Tenant', required: true },
    tenancyId: { type: Schema.Types.ObjectId, ref: 'Tenancy', required: true },
    reference: { type: String, required: true },
    status: { type: String, enum: ['ACTIVE', 'RETIRED'], default: 'ACTIVE', required: true },
    retiredAt: { type: Date, default: null },
    retiredReason: { type: String, enum: ['TENANCY_CLOSED', 'SUPERSEDED', 'ADMIN', null], default: null },
    createdByUserId: { type: Schema.Types.ObjectId, ref: 'User', default: null },
    retiredByUserId: { type: Schema.Types.ObjectId, ref: 'User', default: null },
  },
  { timestamps: true, autoIndex: false, collection: 'mpesacollectionreferences' }
);

MpesaCollectionReferenceSchema.index(
  { merchantProfileId: 1, reference: 1 },
  { unique: true, name: 'uniq_mpesa_ref_merchant_reference' }
);
MpesaCollectionReferenceSchema.index(
  { merchantProfileId: 1, tenancyId: 1 },
  {
    unique: true,
    partialFilterExpression: { status: 'ACTIVE' },
    name: 'uniq_mpesa_ref_active_tenancy',
  }
);
MpesaCollectionReferenceSchema.index(
  { clientId: 1, estateId: 1, tenantId: 1 },
  { name: 'idx_mpesa_ref_tenant_scope' }
);

export const MpesaCollectionReference = mongoose.model(
  'MpesaCollectionReference',
  MpesaCollectionReferenceSchema
);
