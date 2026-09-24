// src/utils/idempotency.js
//
// Generic dedupe helper for retryable operations — bank webhooks, SMS
// sends, background jobs (section 13/27, development rule #7). Given a
// unique key, either returns the existing document or creates a new one,
// atomically enough to survive a duplicate/retried request racing itself.

export async function withIdempotency(Model, key, keyField, createFn) {
  const existing = await Model.findOne({ [keyField]: key });
  if (existing) return { created: false, doc: existing };
  try {
    const doc = await createFn();
    return { created: true, doc };
  } catch (err) {
    if (err.code === 11000) {
      const doc = await Model.findOne({ [keyField]: key });
      if (doc) return { created: false, doc };
    }
    throw err;
  }
}
