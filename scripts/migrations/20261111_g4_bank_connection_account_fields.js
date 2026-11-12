/**
 * G4 Batch 02 — additive BankAccount fields and indexes for connection association.
 *
 * Safe deployment:
 * - Does NOT drop indexes.
 * - Does NOT invent BankConnection rows from provider name or global env credentials.
 * - Does NOT set connectionId on legacy rows (left null until explicit operator backfill).
 * - Dry-run by default unless EXECUTE=1 and allowlisted URI.
 *
 * Usage:
 *   node scripts/migrations/20261111_g4_bank_connection_account_fields.js
 *   EXECUTE=1 MONGODB_URI=... node scripts/migrations/20261111_g4_bank_connection_account_fields.js
 */
import mongoose from 'mongoose';

const EXECUTE = process.env.EXECUTE === '1';
const uri = process.env.MONGODB_URI || '';

function assertSafeUri(u) {
  if (!u) throw new Error('MONGODB_URI required for execute');
  const lower = u.toLowerCase();
  if (lower.includes('prod') && process.env.ALLOW_PROD !== '1') {
    throw new Error('Refusing production-looking URI without ALLOW_PROD=1');
  }
}

async function main() {
  console.log(JSON.stringify({
    migration: '20261111_g4_bank_connection_account_fields',
    execute: EXECUTE,
    note: 'Additive only. Legacy BankAccount.connectionId remains null until explicit backfill.',
  }));

  if (!EXECUTE) {
    console.log('Dry-run only. Schema changes are applied by application models on deploy; this script records intent and optional index ensure.');
    return;
  }

  assertSafeUri(uri);
  await mongoose.connect(uri);
  const col = mongoose.connection.collection('bankaccounts');

  // Ensure indexes matching BankAccount schema (non-destructive createIndexes).
  await col.createIndex({ connectionId: 1 }, { name: 'bankaccount_connectionId', background: true });
  await col.createIndex(
    { clientId: 1, connectionId: 1 },
    { name: 'bankaccount_client_connection', background: true }
  );
  // Physical identity must already exist; do not drop/recreate unique index here.
  const indexes = await col.indexes();
  console.log(JSON.stringify({ indexes: indexes.map((i) => i.name) }, null, 2));
  await mongoose.disconnect();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
