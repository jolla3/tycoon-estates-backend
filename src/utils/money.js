// src/utils/money.js
//
// Section 24: currency-safe calculations. Rent/payment amounts are stored
// and computed in integer cents so we never touch floating-point money math.

export const money = {
  toCents: (amount) => Math.round(Number(amount) * 100),
  fromCents: (cents) => Math.round(cents) / 100,
  add: (aCents, bCents) => aCents + bCents,
  subtract: (aCents, bCents) => aCents - bCents,
  isPositive: (cents) => cents > 0,
  format: (cents, currency = 'KES') => `${currency} ${money.fromCents(cents).toLocaleString('en-KE')}`,
};
