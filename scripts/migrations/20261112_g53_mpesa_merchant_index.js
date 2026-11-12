/**
 * G5.3 — Guarded unique indexes for M-PESA merchant profile and Pull checkpoint.
 * Default: read-only dry run.
 * Mutation: --execute with G5_/G3_ SAFE_DB and HOST allowlists (G3 pattern).
 * Does NOT create provisional receipt unique until B01/B02.
 */
import mongoose from 'mongoose';

const EXECUTE = process.argv.includes('--execute');
const MERCHANT_INDEX_NAME = 'uniq_client_business_shortcode';
const MERCHANT_KEY = { clientId: 1, businessShortCode: 1 };
const CHECKPOINT_INDEX_NAME = 'uniq_mpesa_pull_checkpoint_profile';
const CHECKPOINT_KEY = { merchantProfileId: 1 };

function normalizeAddress(value) {
  const address = String(value || '').trim().toLowerCase();
  if (!address) return '';
  if (address.startsWith('[')) {
    const close = address.indexOf(']');
    if (close < 0) throw new Error(`Invalid bracketed MongoDB address: ${value}`);
    return address.slice(close + 1).startsWith(':') ? address : `${address}:27017`;
  }
  return address.includes(':') ? address : `${address}:27017`;
}

export function parseMongoUri(uri) {
  if (typeof uri !== 'string' || !uri.trim()) throw new Error('MONGODB_URI is required');
  const match = uri.match(/^(mongodb(?:\+srv)?:\/\/)(.*)$/i);
  if (!match) throw new Error('MONGODB_URI must use mongodb:// or mongodb+srv://');
  const scheme = match[1].toLowerCase();
  const remainder = match[2];
  const authorityEnd = remainder.search(/[/?#]/);
  if (authorityEnd < 0) throw new Error('MONGODB_URI must include a database name');
  const authority = remainder.slice(0, authorityEnd);
  const pathAndQuery = remainder.slice(authorityEnd);
  const path = pathAndQuery.split(/[?#]/, 1)[0];
  const encodedDbName = path.replace(/^\/+/, '').split('/')[0];
  if (!authority || !encodedDbName) throw new Error('MONGODB_URI must include authority and database name');
  const at = authority.lastIndexOf('@');
  const hostPart = at >= 0 ? authority.slice(at + 1) : authority;
  const seeds = hostPart.split(',').map((s) => normalizeAddress(s.trim())).filter(Boolean);
  return { scheme, dbName: decodeURIComponent(encodedDbName), seeds };
}

export function assertSafeTarget(uri, execute = EXECUTE) {
  const parsed = parseMongoUri(uri);
  const { dbName, seeds } = parsed;
  const unsafeSystemDb = /^(admin|local|config)$/i.test(dbName);
  const productionNameToken = /(?:^|[^a-z0-9])(?:prod(?:uction)?|live)(?:$|[^a-z0-9])/i;
  if (unsafeSystemDb || productionNameToken.test(dbName)) {
    throw new Error(`Refusing unsafe database name "${dbName}"`);
  }
  if (!execute) return parsed;

  const allowedDbs = new Set(
    String(process.env.G5_SAFE_DB_ALLOWLIST || process.env.G3_SAFE_DB_ALLOWLIST || '')
      .split(',').map((s) => s.trim()).filter(Boolean)
  );
  const targetDb = String(
    process.env.G5_MIGRATION_TARGET_DB || process.env.G3_MIGRATION_TARGET_DB || ''
  ).trim();
  if (!targetDb || targetDb !== dbName || !allowedDbs.has(dbName)) {
    throw new Error(
      `Refusing --execute: database "${dbName}" must equal G5_MIGRATION_TARGET_DB `
        + '(or G3_MIGRATION_TARGET_DB) and appear in G5_SAFE_DB_ALLOWLIST (or G3_SAFE_DB_ALLOWLIST)'
    );
  }
  const allowedAddresses = new Set(
    String(process.env.G5_SAFE_MONGO_HOST_ALLOWLIST || process.env.G3_SAFE_MONGO_HOST_ALLOWLIST || '')
      .split(',').map((s) => normalizeAddress(s.trim())).filter(Boolean)
  );
  if (!allowedAddresses.size) {
    throw new Error('Refusing --execute: set G5_SAFE_MONGO_HOST_ALLOWLIST (or G3_SAFE_MONGO_HOST_ALLOWLIST)');
  }
  const unapprovedSeeds = seeds.filter((address) => {
    const hostOnly = address.replace(/:\d+$/, '');
    return !allowedAddresses.has(address) && !allowedAddresses.has(hostOnly);
  });
  if (unapprovedSeeds.length) {
    throw new Error(`Refusing --execute: URI seed address(es) not allowlisted: ${unapprovedSeeds.join(', ')}`);
  }
  return parsed;
}

export function assertConnectedTarget(connection, expected) {
  if (connection.name !== expected.dbName) {
    throw new Error(`Connected database "${connection.name}" differs from expected "${expected.dbName}"`);
  }
  const allowed = new Set(
    String(process.env.G5_SAFE_MONGO_HOST_ALLOWLIST || process.env.G3_SAFE_MONGO_HOST_ALLOWLIST || '')
      .split(',').map((s) => normalizeAddress(s.trim())).filter(Boolean)
  );
  let connectedAddresses = [];
  if (connection.host) {
    connectedAddresses = [normalizeAddress(`${connection.host}:${connection.port || 27017}`)];
  }
  const unapproved = connectedAddresses.filter((address) => {
    const hostOnly = address.replace(/:\d+$/, '');
    return !allowed.has(address) && !allowed.has(hostOnly);
  });
  if (connectedAddresses.length && unapproved.length) {
    throw new Error(`Refusing --execute: connected MongoDB member(s) not allowlisted: ${unapproved.join(', ')}`);
  }
}

function isExactIndex(idx, key, name, unique = true) {
  if (!idx || !idx.key) return false;
  return JSON.stringify(idx.key) === JSON.stringify(key)
    && Boolean(idx.unique) === Boolean(unique)
    && (!name || idx.name === name);
}

async function main() {
  const uri = process.env.MONGODB_URI;
  const expected = assertSafeTarget(uri, EXECUTE);
  console.log(JSON.stringify({ phase: 'preflight', dbName: expected.dbName, execute: EXECUTE }, null, 2));
  await mongoose.connect(uri);
  if (EXECUTE) assertConnectedTarget(mongoose.connection, expected);

  const merchantCol = mongoose.connection.db.collection('mpesamerchantprofiles');
  const checkpointCol = mongoose.connection.db.collection('mpesapullcheckpoints');

  const duplicates = await merchantCol.aggregate([
    { $group: { _id: { clientId: '$clientId', businessShortCode: '$businessShortCode' }, n: { $sum: 1 } } },
    { $match: { n: { $gt: 1 } } },
    { $limit: 20 },
  ]).toArray();
  if (duplicates.length) {
    console.error(JSON.stringify({ error: 'merchant_duplicates_present', samples: duplicates }, null, 2));
    process.exitCode = 2;
    await mongoose.disconnect();
    return;
  }

  const merchantIndexes = await merchantCol.indexes().catch(() => []);
  const checkpointIndexes = await checkpointCol.indexes().catch(() => []);
  const merchantPresent = merchantIndexes.some((i) => isExactIndex(i, MERCHANT_KEY, MERCHANT_INDEX_NAME, true));
  const checkpointPresent = checkpointIndexes.some((i) => isExactIndex(i, CHECKPOINT_KEY, CHECKPOINT_INDEX_NAME, true));

  console.log(JSON.stringify({
    plan: {
      merchant: merchantPresent ? 'already_present' : (EXECUTE ? 'will_create' : 'dry_run_would_create'),
      checkpoint: checkpointPresent ? 'already_present' : (EXECUTE ? 'will_create' : 'dry_run_would_create'),
      merchantKey: MERCHANT_KEY,
      merchantName: MERCHANT_INDEX_NAME,
      checkpointKey: CHECKPOINT_KEY,
      checkpointName: CHECKPOINT_INDEX_NAME,
    },
  }, null, 2));

  if (EXECUTE) {
    if (!merchantPresent) {
      await merchantCol.createIndex(MERCHANT_KEY, { unique: true, name: MERCHANT_INDEX_NAME });
    }
    if (!checkpointPresent) {
      await checkpointCol.createIndex(CHECKPOINT_KEY, { unique: true, name: CHECKPOINT_INDEX_NAME });
    }
    console.log(JSON.stringify({
      status: 'executed',
      merchantIndexes: await merchantCol.indexes(),
      checkpointIndexes: await checkpointCol.indexes(),
    }, null, 2));
  }
  await mongoose.disconnect();
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
