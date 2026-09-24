// src/services/banking/providers/coop/coop.mapper.js
//
// Converts Co-op's payloads into the app-wide NormalizedBankTransaction
// shape. Two tiers of confidence here, and the comments say which is which:
//
//   - mapCoopWebhookNotification(): the SendTransactionINS body is the
//     ONE transaction schema fully specified in the supplied Co-op docs
//     (every field name, type, and even the date format is given). This
//     mapping is as verified as it can be without a live sandbox call.
//
//   - mapCoopPolledTransaction(): the "Transactions" array returned by
//     AccountTransactions / AccountFullStatement / AccountMiniStatement
//     was NOT expanded in the supplied docs (shown only as `[{}]`) — the
//     per-item field names for polled/historical transactions are
//     UNVERIFIED. This mapper's field-name guesses must be confirmed
//     against a real sandbox response before this path is trusted; until
//     then rawPayload is preserved so nothing is silently lost.

import { money } from '../../../../utils/money.js';

export function extractAccountNumber(raw) {
  // CONFIRMED against the docs: SendTransactionINS's AccountNumber field
  // ("Posting account number", 14 chars) is exactly this.
  return raw.AccountNumber || null;
}

/** Parses Co-op's compact date formats: "20190301165420" (YYYYMMDDHHmmss) or "20190301" (YYYYMMDD). Both are documented example values, not ISO 8601. */
function parseCoopDate(value) {
  if (!value) return null;
  const str = String(value);
  if (/^\d{14}$/.test(str)) {
    const [, y, mo, d, h, mi, s] = str.match(/^(\d{4})(\d{2})(\d{2})(\d{2})(\d{2})(\d{2})$/);
    return new Date(Date.UTC(y, mo - 1, d, h, mi, s));
  }
  if (/^\d{8}$/.test(str)) {
    const [, y, mo, d] = str.match(/^(\d{4})(\d{2})(\d{2})$/);
    return new Date(Date.UTC(y, mo - 1, d));
  }
  // Fall back to native parsing for anything ISO-shaped the sandbox might also return.
  const parsed = new Date(str);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}

/**
 * Maps a SendTransactionINS notification body — CONFIRMED field names
 * per the supplied docs.
 */
export function mapCoopWebhookNotification(raw) {
  return {
    provider: 'COOP',
    providerTransactionId: String(raw.TransactionId || raw.MessageReference),
    accountNumber: raw.AccountNumber,
    amountCents: money.toCents(raw.Amount),
    currency: raw.Currency || 'KES',
    transactionDate: parseCoopDate(raw.TransactionDate),
    valueDate: parseCoopDate(raw.ValueDate),
    paymentReference: raw.PaymentRef || '',
    narration: raw.Narration || '',
    // Docs show EventType "DEBIT" in the example; CREDIT is implied as the
    // counterpart but wasn't shown — default conservatively to whatever's given.
    eventType: (raw.EventType || '').toUpperCase(),
    bookedBalanceCents: raw.BookedBalance != null ? money.toCents(raw.BookedBalance) : null,
    clearedBalanceCents: raw.ClearedBalance != null ? money.toCents(raw.ClearedBalance) : null,
    rawPayload: raw,
  };
}

/**
 * UNVERIFIED — maps one item from an AccountTransactions /
 * AccountFullStatement / AccountMiniStatement response's `Transactions`
 * array. The docs never expanded this item's schema, so these field-name
 * guesses (modeled on the INS notification's field names, since that's
 * the only fully-documented transaction shape from the same API family)
 * must be confirmed against a real sandbox call before this path is used
 * for anything beyond exploratory testing.
 */
export function mapCoopPolledTransaction(raw) {
  return {
    provider: 'COOP',
    providerTransactionId: String(raw.TransactionId || raw.TransactionID || raw.RefNo || ''),
    amountCents: raw.Amount != null ? money.toCents(raw.Amount) : null,
    currency: raw.Currency || 'KES',
    transactionDate: parseCoopDate(raw.TransactionDate || raw.PostingDate || raw.Date),
    paymentReference: raw.PaymentRef || raw.Reference || '',
    narration: raw.Narration || raw.Description || '',
    eventType: (raw.EventType || raw.TransactionType || '').toUpperCase(),
    rawPayload: raw,
    _unverifiedSchema: true,
  };
}
