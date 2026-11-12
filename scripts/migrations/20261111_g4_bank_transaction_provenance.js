/**
 * G4 Batch 03 — additive BankTransaction fields (connectionId, valueDate, balances).
 * Does not alter unique { provider, providerTransactionId }.
 * Dry-run by default.
 */
import mongoose from 'mongoose';

const EXECUTE = process.env.EXECUTE === '1';
const uri = process.env.MONGODB_URI || '';

async function main() {
  console.log(JSON.stringify({
    migration: '20261111_g4_bank_transaction_provenance',
    execute: EXECUTE,
    note: 'Additive indexes only; unique identity unchanged',
  }));
  if (!EXECUTE) return;
  if (!uri) throw new Error('MONGODB_URI required');
  await mongoose.connect(uri);
  const col = mongoose.connection.collection('banktransactions');
  await col.createIndex({ connectionId: 1 }, { name: 'banktransaction_connectionId', background: true });
  await col.createIndex(
    { processingState: 1, processingClaimExpiresAt: 1 },
    { name: 'banktransaction_claim_expiry', background: true }
  );
  console.log(JSON.stringify({ indexes: (await col.indexes()).map((i) => i.name) }));
  await mongoose.disconnect();
}

main().catch((e) => { console.error(e); process.exit(1); });
