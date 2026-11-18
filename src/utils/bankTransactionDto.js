// Allowlist DTO for BankTransaction responses. The model holds provider payloads,
// claim tokens and retry/error internals that must never reach a browser.
// Anything not listed here is dropped, so new model fields are private by default.
const ALLOWED = [
  '_id', 'clientId', 'estateId', 'bankAccountId', 'provider', 'providerTransactionId',
  'amountCents', 'currency', 'transactionDate', 'valueDate', 'paymentReference', 'narration',
  'eventType', 'matchedHouseId', 'matchedTenantId', 'matchedTenancyId', 'matchStatus',
  'processingState', 'createdAt', 'updatedAt',
];

export function toBankTransactionDTO(doc) {
  if (!doc) return doc;
  const src = typeof doc.toObject === 'function' ? doc.toObject() : doc;
  const out = {};
  for (const key of ALLOWED) {
    if (src[key] !== undefined) out[key] = src[key];
  }
  return out;
}

export const BANK_TRANSACTION_DTO_FIELDS = Object.freeze([...ALLOWED]);
