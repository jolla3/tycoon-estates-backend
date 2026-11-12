/**
 * G5.3 — Guarded unique index on mpesamerchantprofiles {clientId, businessShortCode}.
 *
 * Default: read-only dry run.
 * Mutation: --execute with exact database AND server-address allowlists.
 *
 * Does NOT create the provisional shortcode+receipt unique index on mpesatransactions
 * until B01/B02 establish identity scope.
 */
import mongoose from 'mongoose';

const EXECUTE = process.argv.includes('--execute');

function parseMongoUri(uri) {
  if (typeof uri !== 'string' || !uri.trim()) throw new Error('MONGODB_URI is required');
  const match = uri.match(/^(mongodb(?:\+srv)?:\/\/)(.*)$/i);
  if (!match) throw new Error('MONGODB_URI must use mongodb:// or mongodb+srv://');
  const remainder = match[2];
  const authorityEnd = remainder.search(/[/?#]/);
  if (authorityEnd < 0) throw new Error('MONGODB_URI must include a database name');
  const pathAndQuery = remainder.slice(authorityEnd);
  const path = pathAndQuery.split(/[?#]/, 1)[0];
  const encodedDbName = path.replace(/^\/+/, '').split('/')[0];
  return { dbName: decodeURIComponent(encodedDbName) };
}

async function main() {
  const uri = process.env.MONGODB_URI;
  const { dbName } = parseMongoUri(uri);
  console.log(JSON.stringify({ phase: 'preflight', dbName, execute: EXECUTE }, null, 2));

  await mongoose.connect(uri);
  const col = mongoose.connection.db.collection('mpesamerchantprofiles');

  const duplicates = await col.aggregate([
    { $group: { _id: { clientId: '$clientId', businessShortCode: '$businessShortCode' }, n: { $sum: 1 } } },
    { $match: { n: { $gt: 1 } } },
    { $limit: 20 },
  ]).toArray();

  if (duplicates.length) {
    console.error(JSON.stringify({ error: 'duplicates_present', samples: duplicates }, null, 2));
    process.exitCode = 2;
    await mongoose.disconnect();
    return;
  }

  const existing = await col.indexes();
  const target = existing.find(
    (i) => i.key?.clientId === 1 && i.key?.businessShortCode === 1 && i.unique
  );

  if (target) {
    console.log(JSON.stringify({ status: 'already_present', name: target.name }, null, 2));
  } else if (!EXECUTE) {
    console.log(JSON.stringify({
      status: 'dry_run_would_create',
      key: { clientId: 1, businessShortCode: 1 },
    }, null, 2));
  } else {
    await col.createIndex(
      { clientId: 1, businessShortCode: 1 },
      { unique: true, name: 'uniq_client_business_shortcode' }
    );
    const after = await col.indexes();
    console.log(JSON.stringify({ status: 'created', indexes: after }, null, 2));
  }

  await mongoose.disconnect();
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
