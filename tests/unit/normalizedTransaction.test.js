import '../setup.js';
import {
  validateNormalizedTransaction,
  directionFromCreditDebitAmounts,
} from '../../src/services/banking/normalizedTransaction.js';
import { money } from '../../src/utils/money.js';

describe('normalized transaction contract', () => {
  const base = {
    provider: 'COOP',
    providerTransactionId: 'TX-1',
    eventType: 'CREDIT',
    amountCents: 10000,
    currency: 'KES',
    transactionDate: new Date('2026-01-15T00:00:00Z'),
  };

  test('accepts explicit CREDIT and DEBIT', () => {
    expect(validateNormalizedTransaction(base).ok).toBe(true);
    expect(validateNormalizedTransaction({ ...base, eventType: 'DEBIT' }).ok).toBe(true);
  });

  test('rejects missing or invalid direction without defaulting to CREDIT', () => {
    expect(validateNormalizedTransaction({ ...base, eventType: '' }).ok).toBe(false);
    expect(validateNormalizedTransaction({ ...base, eventType: undefined }).ok).toBe(false);
    expect(validateNormalizedTransaction({ ...base, eventType: 'TRANSFER' }).ok).toBe(false);
  });

  test('rejects missing providerTransactionId', () => {
    expect(validateNormalizedTransaction({ ...base, providerTransactionId: '' }).ok).toBe(false);
  });

  test('preserves valueDate separately from transactionDate', () => {
    const valueDate = new Date('2026-01-16T00:00:00Z');
    const r = validateNormalizedTransaction({ ...base, valueDate });
    expect(r.ok).toBe(true);
    expect(r.value.transactionDate.toISOString()).toBe(base.transactionDate.toISOString());
    expect(r.value.valueDate.toISOString()).toBe(valueDate.toISOString());
  });

  test('directionFromCreditDebitAmounts does not invent CREDIT', () => {
    expect(directionFromCreditDebitAmounts(100, 0, money.toCents).eventType).toBe('CREDIT');
    expect(directionFromCreditDebitAmounts(0, 50, money.toCents).eventType).toBe('DEBIT');
    expect(directionFromCreditDebitAmounts(0, 0, money.toCents).ok).toBe(false);
    expect(directionFromCreditDebitAmounts(10, 10, money.toCents).ok).toBe(false);
  });
});
