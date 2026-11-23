// Pure RentCharge aggregation for customer notifications. Never turn absent or
// malformed financial data into a fabricated zero balance.
const TYPES = Object.freeze(['RENT', 'WATER', 'ELECTRICITY', 'OTHER']);
const CHARGE_TYPE_PRIORITY = Object.freeze({
  RENT: 0,
  WATER: 1,
  ELECTRICITY: 2,
  OTHER: 3,
});

function requireCents(value, field, { signed = false } = {}) {
  if (!Number.isSafeInteger(value) || (!signed && value < 0)) {
    const err = new Error(`Invalid billing data: ${field} must be a ${signed ? 'safe integer' : 'non-negative safe integer'} number of cents`);
    err.code = 'SMS_BILLING_AMOUNT_INVALID';
    throw err;
  }
  return value;
}

function normalizeDescription(description, chargeType) {
  return String(description || chargeType || '').trim().toLowerCase();
}

/**
 * Line-level outstanding projection for D-5 (and similar) reminders.
 * outstandingCents is the positive saved balanceCents, not amountDueCents.
 * Preserves custom descriptions; does not collapse OTHER lines.
 * Deterministic order: charge-type priority, normalized description, charge id.
 */
export function projectOutstandingChargeLines(charges) {
  if (!Array.isArray(charges)) {
    const err = new Error('Billing details are not available for this period');
    err.code = 'SMS_BILLING_DATA_UNAVAILABLE';
    throw err;
  }
  const lines = [];
  for (const charge of charges) {
    const balance = requireCents(charge.balanceCents, 'balanceCents', { signed: true });
    const outstandingCents = Math.max(balance, 0);
    if (outstandingCents <= 0) continue;
    const chargeType = TYPES.includes(charge.chargeType) ? charge.chargeType : 'OTHER';
    const description = String(charge.description || charge.chargeType || '').trim() || chargeType;
    const rentChargeId = charge._id != null ? String(charge._id) : '';
    if (!rentChargeId) {
      const err = new Error('Billing charge identity is missing');
      err.code = 'SMS_BILLING_CHARGE_IDENTITY_MISSING';
      throw err;
    }
    lines.push({
      rentChargeId,
      chargeType,
      description,
      outstandingCents,
    });
  }
  lines.sort((a, b) => {
    const pa = CHARGE_TYPE_PRIORITY[a.chargeType] ?? 99;
    const pb = CHARGE_TYPE_PRIORITY[b.chargeType] ?? 99;
    if (pa !== pb) return pa - pb;
    const da = normalizeDescription(a.description, a.chargeType);
    const db = normalizeDescription(b.description, b.chargeType);
    if (da < db) return -1;
    if (da > db) return 1;
    if (a.rentChargeId < b.rentChargeId) return -1;
    if (a.rentChargeId > b.rentChargeId) return 1;
    return 0;
  });
  return lines;
}

export function aggregateRentCharges(charges, { allowEmpty = false } = {}) {
  if (!Array.isArray(charges) || (!allowEmpty && charges.length === 0)) {
    const err = new Error('Billing details are not available for this period');
    err.code = 'SMS_BILLING_DATA_UNAVAILABLE';
    throw err;
  }
  const result = {
    rentCents: 0, waterCents: 0, electricityCents: 0, otherCents: 0,
    rentOutstandingCents: 0, waterOutstandingCents: 0, electricityOutstandingCents: 0, otherOutstandingCents: 0,
    paidCents: 0, totalOutstandingCents: 0, lineCount: charges.length,
    dueDates: [],
  };
  const dueDates = new Set();
  for (const charge of charges) {
    const type = TYPES.includes(charge.chargeType) ? charge.chargeType : 'OTHER';
    const due = requireCents(charge.amountDueCents, 'amountDueCents');
    const paid = requireCents(charge.amountPaidCents, 'amountPaidCents');
    const balance = requireCents(charge.balanceCents, 'balanceCents', { signed: true });
    const key = type === 'RENT' ? 'rentCents'
      : type === 'WATER' ? 'waterCents'
        : type === 'ELECTRICITY' ? 'electricityCents' : 'otherCents';
    result[key] += due;
    const outstandingKey = key.replace('Cents', 'OutstandingCents');
    result[outstandingKey] += Math.max(balance, 0);
    result.paidCents += paid;
    result.totalOutstandingCents += Math.max(balance, 0);
    if (charge.dueDate) {
      const date = new Date(charge.dueDate);
      if (!Number.isFinite(date.getTime())) {
        const err = new Error('Billing due date is invalid');
        err.code = 'SMS_BILLING_DUE_DATE_INVALID';
        throw err;
      }
      dueDates.add(date.toISOString());
    }
  }
  for (const key of ['rentCents', 'waterCents', 'electricityCents', 'otherCents', 'rentOutstandingCents', 'waterOutstandingCents', 'electricityOutstandingCents', 'otherOutstandingCents', 'paidCents', 'totalOutstandingCents']) {
    requireCents(result[key], key);
  }
  result.dueDates = [...dueDates].sort().map((value) => new Date(value));
  return result;
}

export function sumOutstandingCents(charges, { allowEmpty = true } = {}) {
  return aggregateRentCharges(charges, { allowEmpty }).totalOutstandingCents;
}
