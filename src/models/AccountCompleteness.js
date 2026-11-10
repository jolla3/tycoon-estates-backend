import mongoose from 'mongoose';
const { Schema } = mongoose;
const AccountCompletenessSchema = new Schema({
  clientId: { type: Schema.Types.ObjectId, ref: 'Client', required: true, index: true },
  tenancyId: { type: Schema.Types.ObjectId, ref: 'Tenancy', required: true },
  accountCategory: { type: String, enum: ['RENT', 'DEPOSIT'], required: true },
  state: { type: String, enum: ['MIGRATION_PENDING', 'INCOMPLETE', 'COMPLETE'], default: 'MIGRATION_PENDING', required: true },
  unresolvedCount: { type: Number, default: 0 },
  notes: { type: String, default: '' },
}, { timestamps: true });
AccountCompletenessSchema.index({ tenancyId: 1, accountCategory: 1 }, { unique: true });
export const AccountCompleteness = mongoose.model('AccountCompleteness', AccountCompletenessSchema);
