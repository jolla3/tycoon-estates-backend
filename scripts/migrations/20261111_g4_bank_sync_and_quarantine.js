/**
 * G4 Batch 04 — additive sync metadata indexes + quarantine collection indexes.
 * Dry-run by default. Does not drop indexes or invent connections.
 */
import mongoose from 'mongoose';

const EXECUTE = process.env.EXECUTE === '1';
const uri = process.env.MONGODB_URI || '';

async function main() {
  console.log(JSON.stringify({
    migration: '20261111_g4_bank_sync_and_quarantine',
    execute: EXECUTE,
  }));
  if (!EXECUTE) return;
  if (!uri) throw new Error('MONGODB_URI required');
  await mongoose.connect(uri);
  const accounts = mongoose.connection.collection('bankaccounts');
  await accounts.createIndex(
    { 'sync.leaseExpiresAt': 1, 'sync.status': 1 },
    { name: 'bankaccount_sync_lease', background: true }
  );
  const q = mongoose.connection.collection('bankcallbackquarantines');
  await q.createIndex({ provider: 1, payloadDigest: 1, status: 1 }, { background: true });
  await q.createIndex({ status: 1, receivedAt: -1 }, { background: true });
  console.log('indexes ensured');
  await mongoose.disconnect();
}

main().catch((e) => { console.error(e); process.exit(1); });
