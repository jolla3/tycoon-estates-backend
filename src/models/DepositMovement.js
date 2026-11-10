import mongoose from 'mongoose';
const { Schema } = mongoose;
const TYPES = ['RECEIVED', 'DEDUCTION', 'REFUND', 'TRANSFER_OUT', 'TRANSFER_IN'];
const DepositMovementSchema = new Schema({
  clientId: { type: Schema.Types.ObjectId, ref: 'Client', required: true, index: true },
  estateId: { type: Schema.Types.ObjectId, ref: 'Estate', required: true },
  houseId: { type: Schema.Types.ObjectId, ref: 'House', required: true },
  tenantId: { type: Schema.Types.ObjectId, ref: 'Tenant', required: true },
  tenancyId: { type: Schema.Types.ObjectId, ref: 'Tenancy', required: true, index: true },
  depositId: { type: Schema.Types.ObjectId, ref: 'Deposit', required: true, index: true },
  type: { type: String, enum: TYPES, required: true },
  amountCents: { type: Number, required: true },
  actorUserId: { type: Schema.Types.ObjectId, ref: 'User', default: null },
  idempotencyKey: { type: String, default: null },
  linkedMovementId: { type: Schema.Types.ObjectId, ref: 'DepositMovement', default: null },
  notes: { type: String, default: '' },
}, { timestamps: true });
DepositMovementSchema.index({ clientId: 1, idempotencyKey: 1 }, { unique: true, partialFilterExpression: { idempotencyKey: { $type: 'string' } } });
export const DepositMovement = mongoose.model('DepositMovement', DepositMovementSchema);
export const DEPOSIT_MOVEMENT_TYPES = TYPES;
