// src/models/HouseTypePlanVersion.js
// Append-only Estate-owned recurring billing plan history.
import mongoose from 'mongoose';
const { Schema } = mongoose;

const PlanLineSchema = new Schema({
  lineId: { type: String, required: true },
  chargeType: { type: String, enum: ['RENT', 'WATER', 'ELECTRICITY', 'OTHER'], required: true },
  description: { type: String, required: true, trim: true, maxlength: 200 },
  amountCents: { type: Number, required: true, min: 1 },
  dueDay: { type: Number, min: 1, max: 31 },
}, { _id: false });

PlanLineSchema.path('amountCents').validate(Number.isSafeInteger, 'amountCents must be a safe integer');

const HouseTypePlanVersionSchema = new Schema({
  clientId: { type: Schema.Types.ObjectId, ref: 'Client', required: true, index: true },
  estateId: { type: Schema.Types.ObjectId, ref: 'Estate', required: true, index: true },
  houseTypeId: { type: Schema.Types.ObjectId, ref: 'HouseType', required: true, index: true },
  version: { type: Number, required: true, min: 1 },
  effectiveFromPeriod: { type: String, required: true, match: /^\d{4}-(0[1-9]|1[0-2])$/ },
  lines: { type: [PlanLineSchema], required: true, default: [] },
  createdBy: { type: Schema.Types.ObjectId, ref: 'User', default: null },
  changeReason: { type: String, trim: true, maxlength: 500, default: '' },
}, { timestamps: true, versionKey: false, autoIndex: false });

HouseTypePlanVersionSchema.index({ houseTypeId: 1, version: 1 }, {
  unique: true, name: 'uniq_house_type_plan_version',
});
HouseTypePlanVersionSchema.index({ houseTypeId: 1, effectiveFromPeriod: 1 }, {
  unique: true, name: 'uniq_house_type_plan_effective_period',
});
HouseTypePlanVersionSchema.index({ clientId: 1, estateId: 1, houseTypeId: 1, effectiveFromPeriod: -1 });

HouseTypePlanVersionSchema.pre('validate', function(next) {
  const seen = new Set();
  for (const line of this.lines || []) {
    const key = `${String(line.chargeType || '').toUpperCase()}::${String(line.description || '').trim().toLocaleLowerCase('en')}`;
    if (seen.has(key)) {
      this.invalidate('lines', `Duplicate plan line identity: ${line.chargeType}/${line.description}`);
      break;
    }
    seen.add(key);
  }
  next();
});

const immutableWrite = function(next) {
  next(new Error('HouseType plan versions are immutable; append a new version.'));
};
HouseTypePlanVersionSchema.pre('save', function(next) {
  if (!this.isNew) return next(new Error('HouseType plan versions cannot be updated.'));
  next();
});
for (const operation of ['updateOne', 'updateMany', 'findOneAndUpdate', 'replaceOne', 'deleteOne', 'deleteMany', 'findOneAndDelete']) {
  HouseTypePlanVersionSchema.pre(operation, immutableWrite);
}

export const HouseTypePlanVersion = mongoose.model('HouseTypePlanVersion', HouseTypePlanVersionSchema);
