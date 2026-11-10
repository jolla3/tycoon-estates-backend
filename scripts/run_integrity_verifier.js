/**
 * Read-only G3.5 integrity verifier CLI.
 * Usage: MONGODB_URI=... node scripts/run_integrity_verifier.js [--clientId=...]
 * Never mutates data.
 */
import mongoose from 'mongoose';
import { runIntegrityVerifier } from '../src/services/integrityVerifier.service.js';

const clientArg = process.argv.find((a) => a.startsWith('--clientId='));
const clientId = clientArg ? clientArg.split('=')[1] : null;

async function main() {
  const uri = process.env.MONGODB_URI;
  if (!uri) {
    console.error('MONGODB_URI required');
    process.exit(2);
  }
  await mongoose.connect(uri, {
    autoIndex: false,
    autoCreate: false,
  });
  const report = await runIntegrityVerifier({ clientId });
  console.log(JSON.stringify(report, null, 2));
  await mongoose.disconnect();
  process.exit(report.ok ? 0 : 1);
}

main().catch(async (err) => {
  console.error(err);
  try { await mongoose.disconnect(); } catch { /* ignore */ }
  process.exit(1);
});
