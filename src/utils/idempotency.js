// src/utils/idempotency.js
//
// Generic dedupe helper. For BankTransaction, prefer
// transactionIngestion.persistNormalizedTransaction which matches the
// compound unique index { provider, providerTransactionId } and checks ownership.

export async function withIdempotency(Model, key, keyField, createFn) {
  const filter = typeof keyField === 'object' && keyField !== null
    ? keyField
    : { [keyField]: key };

  const existing = await Model.findOne(filter);
  if (existing) return { created: false, doc: existing };
  try {
    const doc = await createFn();
    return { created: true, doc };
  } catch (err) {
    if (err.code === 11000) {
      const doc = await Model.findOne(filter);
      if (doc) return { created: false, doc };
    }
    throw err;
  }
}
