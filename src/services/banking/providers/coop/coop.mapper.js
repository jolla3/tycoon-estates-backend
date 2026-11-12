// src/services/banking/providers/coop/coop.mapper.js
//
// Converts Co-op payloads into the normalized transaction candidate shape.
// Direction is never defaulted to CREDIT.

import { money } from '../../../../utils/money.js';
import { directionFromCreditDebitAmounts } from '../../normalizedTransaction.js';

export function extractAccountNumber(raw) {
  return raw.AccountNumber || null;
}

/** Parses Co-op compact dates: "20190301165420" or "20190301". */
function parseCoopDate(value) {
  if (!value) return null;
  const str = String(value);
  if (/^\d{14}$/.test(str)) {
    const [, y, mo, d, h, mi, s] = str.match(/^(\d{4})(\d{2})(\d{2})(\d{2})(\d{2})(\d{2})$/);
    return new Date(Date.UTC(+y, +mo - 1, +d, +h, +mi, +s));
  }
  if (/^\d{8}$/.test(str)) {
    const [, y, mo, d] = str.match(/^(\d{4})(\d{2})(\d{2})$/);
    return new Date(Date.UTC(+y, +mo - 1, +d));
  }
  const parsed = new Date(str);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}

/** SendTransactionINS — documented field names. */
export function mapCoopWebhookNotification(raw) {
  return {
    provider: 'COOP',
    providerTransactionId: String(raw.TransactionId || raw.MessageReference || ''),
    accountNumber: raw.AccountNumber,
    amountCents: raw.Amount != null ? money.toCents(raw.Amount) : null,
    currency: raw.Currency || 'KES',
    transactionDate: parseCoopDate(raw.TransactionDate),
    valueDate: parseCoopDate(raw.ValueDate),
    paymentReference: raw.PaymentRef || '',
    narration: raw.Narration || '',
    eventType: (raw.EventType || '').toUpperCase(),
    bookedBalanceCents: raw.BookedBalance != null ? money.toCents(raw.BookedBalance) : null,
    clearedBalanceCents: raw.ClearedBalance != null ? money.toCents(raw.ClearedBalance) : null,
    rawPayload: raw,
  };
}

/**
 * UNVERIFIED polled AccountTransactions item schema.
 * Field names are guesses until sandbox confirmation.
 */
export function mapCoopPolledTransaction(raw) {
  return {
    provider: 'COOP',
    providerTransactionId: String(raw.TransactionId || raw.TransactionID || raw.RefNo || ''),
    amountCents: raw.Amount != null ? money.toCents(raw.Amount) : null,
    currency: raw.Currency || 'KES',
    transactionDate: parseCoopDate(raw.TransactionDate || raw.PostingDate || raw.Date),
    valueDate: parseCoopDate(raw.ValueDate),
    paymentReference: raw.PaymentRef || raw.Reference || '',
    narration: raw.Narration || raw.Description || '',
    eventType: (raw.EventType || raw.TransactionType || '').toUpperCase(),
    rawPayload: raw,
    _unverifiedSchema: true,
  };
}

/**
 * Documented FullStatement-style item: CreditAmount/DebitAmount define direction.
 * TransactionDate and ValueDate are preserved separately.
 */
export function mapCoopFullStatementItem(raw) {
  // Prefer explicit amounts when present; otherwise TransactionType C/D per FullStatement OpenAPI.
  let dir = directionFromCreditDebitAmounts(
    raw.CreditAmount,
    raw.DebitAmount,
    (v) => money.toCents(v)
  );
  if (!dir.ok) {
    const tt = String(raw.TransactionType || '').trim().toUpperCase();
    const amountSource = raw.CreditAmount ?? raw.DebitAmount ?? raw.Amount;
    if ((tt === 'C' || tt === 'CREDIT') && amountSource != null) {
      dir = { ok: true, eventType: 'CREDIT', amountCents: money.toCents(amountSource) };
    } else if ((tt === 'D' || tt === 'DEBIT') && amountSource != null) {
      dir = { ok: true, eventType: 'DEBIT', amountCents: money.toCents(amountSource) };
    }
  }
  return {
    provider: 'COOP',
    providerTransactionId: String(raw.TransactionId || ''),
    transactionDate: parseCoopDate(raw.TransactionDate),
    valueDate: parseCoopDate(raw.ValueDate),
    paymentReference: raw.TransactionReference || '',
    narration: raw.Narration || '',
    eventType: dir.ok ? dir.eventType : '',
    amountCents: dir.ok ? dir.amountCents : null,
    bookedBalanceCents: raw.RunningBookBalance != null ? money.toCents(raw.RunningBookBalance) : null,
    clearedBalanceCents: raw.RunningClearedBalance != null ? money.toCents(raw.RunningClearedBalance) : null,
    rawPayload: raw,
    _directionError: dir.ok ? null : dir.error,
  };
}
