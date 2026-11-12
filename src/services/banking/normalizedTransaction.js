// src/services/banking/normalizedTransaction.js
//
// G4 Batch 03: bank-neutral normalized transaction contract.
// Provider adapters map raw payloads into this shape; the shared ingestion
// pipeline validates and persists it. Direction is never inferred as CREDIT.

export const TRANSACTION_DIRECTIONS = Object.freeze(['CREDIT', 'DEBIT']);

/**
 * Validate and freeze a normalized transaction candidate before persistence.
 *
 * Required:
 * - provider, providerTransactionId (stable identity)
 * - eventType CREDIT|DEBIT (explicit; never defaulted)
 * - amountCents (positive integer for money movement magnitude)
 * - transactionDate (Date used for G3 historical tenancy matching)
 * - currency
 *
 * Optional provenance supplied by ingestion from BankAccount context:
 * - clientId, estateId, bankAccountId, connectionId
 *
 * Optional provider fields:
 * - valueDate (settlement; must not replace transactionDate)
 * - paymentReference, narration
 * - bookedBalanceCents, clearedBalanceCents
 * - rawPayload (must not contain secrets)
 * - sourceChannel: 'poll' | 'webhook' | 'import' | 'unknown'
 * - schemaUnverified: true when adapter marks mapping as unverified
 */
export function validateNormalizedTransaction(input) {
  const errors = [];
  if (!input || typeof input !== 'object') {
    return { ok: false, errors: ['normalized transaction must be an object'], value: null };
  }

  const provider = String(input.provider || '').toUpperCase();
  if (!provider) errors.push('provider is required');

  const providerTransactionId = input.providerTransactionId != null
    ? String(input.providerTransactionId).trim()
    : '';
  if (!providerTransactionId) {
    errors.push('providerTransactionId is required for reliable deduplication');
  }

  const rawDirection = input.eventType != null ? String(input.eventType).trim().toUpperCase() : '';
  if (!rawDirection) {
    errors.push('eventType (direction) is required and must be explicit');
  } else if (!TRANSACTION_DIRECTIONS.includes(rawDirection)) {
    errors.push(`eventType must be CREDIT or DEBIT, got: ${rawDirection}`);
  }

  let amountCents = input.amountCents;
  if (amountCents == null || amountCents === '') {
    errors.push('amountCents is required');
  } else {
    amountCents = Number(amountCents);
    if (!Number.isInteger(amountCents) || amountCents <= 0) {
      errors.push('amountCents must be a positive integer');
    }
  }

  let transactionDate = input.transactionDate;
  if (!(transactionDate instanceof Date) || Number.isNaN(transactionDate.getTime())) {
    errors.push('transactionDate must be a valid Date (G3 tenancy matching date)');
  }

  let valueDate = input.valueDate;
  if (valueDate != null && valueDate !== '') {
    if (!(valueDate instanceof Date) || Number.isNaN(valueDate.getTime())) {
      errors.push('valueDate must be a valid Date when provided');
      valueDate = undefined;
    }
  } else {
    valueDate = null;
  }

  const currency = String(input.currency || 'KES').toUpperCase();

  if (errors.length) {
    return { ok: false, errors, value: null };
  }

  const value = {
    provider,
    providerTransactionId,
    eventType: rawDirection,
    amountCents,
    currency,
    transactionDate,
    valueDate,
    paymentReference: input.paymentReference != null ? String(input.paymentReference) : '',
    narration: input.narration != null ? String(input.narration) : '',
    bookedBalanceCents: input.bookedBalanceCents != null ? Number(input.bookedBalanceCents) : null,
    clearedBalanceCents: input.clearedBalanceCents != null ? Number(input.clearedBalanceCents) : null,
    rawReference: input.rawReference != null ? String(input.rawReference) : '',
    sourceChannel: input.sourceChannel || 'unknown',
    schemaUnverified: Boolean(input.schemaUnverified || input._unverifiedSchema),
    rawPayload: input.rawPayload != null ? input.rawPayload : undefined,
  };

  return { ok: true, errors: [], value };
}

/**
 * Map FullStatement-style fields (documented) without collapsing ValueDate into TransactionDate.
 * CreditAmount / DebitAmount establish direction; both non-zero or both zero → reject.
 */
export function directionFromCreditDebitAmounts(creditAmount, debitAmount, toCents) {
  const credit = creditAmount != null && creditAmount !== '' ? toCents(creditAmount) : 0;
  const debit = debitAmount != null && debitAmount !== '' ? toCents(debitAmount) : 0;
  if (credit > 0 && debit > 0) {
    return { ok: false, error: 'both CreditAmount and DebitAmount are non-zero' };
  }
  if (credit > 0) return { ok: true, eventType: 'CREDIT', amountCents: credit };
  if (debit > 0) return { ok: true, eventType: 'DEBIT', amountCents: debit };
  return { ok: false, error: 'neither CreditAmount nor DebitAmount is positive' };
}
