/**
 * G4 Correction 6 — additive BankConnection indexes from model specs.
 * Non-unique: multiple connections per client+provider remain allowed.
 * Dry-run by default. EXECUTE=1 to apply.
 */
import mongoose from 'mongoose';
import { BANK_CONNECTION_INDEX_SPECS } from '../../src/models/BankConnection.js';

const EXECUTE = process.env.EXECUTE === '1';
const uri = process.env.MONGODB_URI || '';

function assertSafeUri(u) {
  if (!u) throw new Error('MONGODB_URI required for execute');
  if (u.toLowerCase().includes('prod') && process.env.ALLOW_PROD !== '1') {
    throw new Error('Refusing production-looking URI without ALLOW_PROD=1');
  }
}

async function main() {
  const report = {
    migration: '20261111_g4_bank_connection_indexes',
    execute: EXECUTE,
    specs: BANK_CONNECTION_INDEX_SPECS,
  };
  console.log(JSON.stringify(report, null, 2));
  if (!EXECUTE) {
    console.log('Dry-run only — no indexes created.');
    return;
  }
  assertSafeUri(uri);
  await mongoose.connect(uri);
  const col = mongoose.connection.collection('bankconnections');
  const existing = await col.indexes();
  const existingNames = new Set(existing.map((i) => i.name));
  for (const spec of BANK_CONNECTION_INDEX_SPECS) {
    if (existingNames.has(spec.name)) {
      console.log(JSON.stringify({ skip: spec.name, reason: 'exists' }));
      continue;
    }
    // Match by key shape if name differs
    const sameKey = existing.find((i) => JSON.stringify(i.key) === JSON.stringify(spec.key));
    if (sameKey) {
      console.log(JSON.stringify({ skip: spec.name, reason: 'equivalent_key', existing: sameKey.name }));
      continue;
    }
    await col.createIndex(spec.key, {
      name: spec.name,
      unique: Boolean(spec.unique),
      background: true,
    });
    console.log(JSON.stringify({ created: spec.name }));
  }
  console.log(JSON.stringify({ indexes: (await col.indexes()).map((i) => ({ name: i.name, key: i.key })) }));
  await mongoose.disconnect();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
