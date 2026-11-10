/** Strict positive safe-integer cents. Never truncates fractions into valid money. */
export function requirePositiveSafeCents(value, field = 'amountCents') {
  if (typeof value === 'string' && value.trim() !== '') {
    // reject decimal strings explicitly
    if (!/^-?\d+$/.test(value.trim())) {
      const err = new Error(`${field} must be a positive safe integer`);
      err.code = 'INVALID_CENTS';
      throw err;
    }
    value = Number(value.trim());
  }
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    const err = new Error(`${field} must be a positive safe integer`);
    err.code = 'INVALID_CENTS';
    throw err;
  }
  if (!Number.isInteger(value) || !Number.isSafeInteger(value) || value <= 0) {
    const err = new Error(`${field} must be a positive safe integer`);
    err.code = 'INVALID_CENTS';
    throw err;
  }
  return value;
}

export function requireNonZeroSafeCents(value, field = 'amountCents') {
  if (typeof value === 'string' && value.trim() !== '') {
    if (!/^-?\d+$/.test(value.trim())) {
      const err = new Error(`${field} must be a non-zero safe integer`);
      err.code = 'INVALID_CENTS';
      throw err;
    }
    value = Number(value.trim());
  }
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    const err = new Error(`${field} must be a non-zero safe integer`);
    err.code = 'INVALID_CENTS';
    throw err;
  }
  if (!Number.isInteger(value) || !Number.isSafeInteger(value) || value === 0) {
    const err = new Error(`${field} must be a non-zero safe integer`);
    err.code = 'INVALID_CENTS';
    throw err;
  }
  return value;
}
