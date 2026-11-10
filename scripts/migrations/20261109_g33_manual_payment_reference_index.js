/**
 * G3.3 MANUAL payment-reference idempotency index.
 * Default: read-only duplicate preflight. --execute creates only the exact
 * target index after duplicate groups are absent. No records are modified.
 * Requires an explicitly allowlisted disposable MongoDB database and hosts.
 */
import mongoose from 'mongoose';
import { MANUAL_PAYMENT_REFERENCE_INDEX } from '../../src/utils/manualPaymentIndexReadiness.js';

const EXECUTE = process.argv.includes('--execute');
const TARGET = MANUAL_PAYMENT_REFERENCE_INDEX;

function normalizeAddress(value) {
  const raw = String(value || '').trim().toLowerCase();
  if (!raw) return '';
  if (raw.startsWith('[')) {
    const end = raw.indexOf(']');
    if (end < 0) throw new Error(`Invalid MongoDB address: ${value}`);
    return raw.slice(end + 1).startsWith(':') ? raw : `${raw}:27017`;
  }
  return raw.includes(':') ? raw : `${raw}:27017`;
}

function parseUri(uri) {
  const match = String(uri || '').match(/^(mongodb:\/\/)(.*)$/i);
  if (!match) throw new Error('MONGODB_URI must use standard mongodb:// for this guarded migration');
  const remainder = match[2];
  const authorityEnd = remainder.search(/[/?#]/);
  if (authorityEnd < 0) throw new Error('MONGODB_URI must include a database name');
  const authority = remainder.slice(0, authorityEnd);
  const path = remainder.slice(authorityEnd).split(/[?#]/, 1)[0];
  const dbName = decodeURIComponent(path.replace(/^\/+/, '').split('/')[0] || '');
  const hosts = authority.slice(authority.lastIndexOf('@') + 1).split(',').map(normalizeAddress);
  if (!dbName || !hosts.length || hosts.some((host) => !host)) throw new Error('Invalid MongoDB URI authority/database');
  return { dbName, hosts };
}

function assertTarget(uri) {
  const parsed = parseUri(uri);
  if (/^(admin|local|config)$/i.test(parsed.dbName)
    || /(?:^|[^a-z0-9])(?:prod(?:uction)?|live)(?:$|[^a-z0-9])/i.test(parsed.dbName)) {
    throw new Error(`Refusing unsafe database name: ${parsed.dbName}`);
  }
  const allowedDbs = new Set(String(process.env.G3_SAFE_DB_ALLOWLIST || '').split(',').map((v) => v.trim()).filter(Boolean));
  const configuredTarget = String(process.env.G3_MIGRATION_TARGET_DB || '').trim();
  const allowedHosts = new Set(String(process.env.G3_SAFE_MONGO_ADDRESSES || '')
    .split(',').map((v) => normalizeAddress(v)).filter(Boolean));
  if (!configuredTarget || configuredTarget !== parsed.dbName || !allowedDbs.has(parsed.dbName)) {
    throw new Error(`Database ${parsed.dbName} must equal G3_MIGRATION_TARGET_DB and appear in G3_SAFE_DB_ALLOWLIST`);
  }
  if (!allowedHosts.size || parsed.hosts.some((host) => !allowedHosts.has(host))) {
    throw new Error('Every MongoDB URI host must appear in G3_SAFE_MONGO_ADDRESSES');
  }
  return { ...parsed, allowedHosts };
}

function keyMatches(actual, expected) {
  return Boolean(actual)
    && Object.keys(actual).length === Object.keys(expected).length
    && Object.keys(expected).every((key, i) => Object.keys(actual)[i] === key && actual[key] === expected[key]);
}

function targetMatches(index) {
  const partial = index?.partialFilterExpression;
  return Boolean(index && index.unique === true
    && keyMatches(index.key, TARGET.key)
    && partial?.origin === 'MANUAL'
    && partial?.paymentReference?.$type === 'string'
    && partial?.paymentReference?.$gt === ''
    && Object.keys(partial).length === 2
    && Object.keys(partial.paymentReference).length === 2);
}

async function main() {
  const uri = process.env.MONGODB_URI;
  if (!uri) throw new Error('MONGODB_URI is required');
  const expected = assertTarget(uri);
  await mongoose.connect(uri, {
    autoIndex: false,
    autoCreate: false,
  });
  try {
    if (mongoose.connection.name !== expected.dbName) throw new Error('Connected database differs from allowlisted target');
    const servers = mongoose.connection.getClient()?.topology?.description?.servers;
    const connected = servers instanceof Map
      ? [...servers.keys()].map(normalizeAddress)
      : [normalizeAddress(`${mongoose.connection.host}:${mongoose.connection.port || 27017}`)];
    if (!connected.length || connected.some((host) => !expected.allowedHosts.has(host))) {
      throw new Error(`Connected MongoDB members are not all allowlisted: ${connected.join(', ')}`);
    }

    const payments = mongoose.connection.db.collection('payments');
    const match = { origin: 'MANUAL', paymentReference: { $type: 'string', $gt: '' } };
    const duplicateCountRows = await payments.aggregate([
      { $match: match },
      { $group: { _id: { clientId: '$clientId', paymentReference: '$paymentReference' }, count: { $sum: 1 } } },
      { $match: { count: { $gt: 1 } } },
      { $count: 'groupCount' },
    ], { allowDiskUse: true }).toArray();
    const duplicateCount = duplicateCountRows[0]?.groupCount || 0;
    const duplicateSamples = await payments.aggregate([
      { $match: match },
      { $group: {
        _id: { clientId: '$clientId', paymentReference: '$paymentReference' },
        count: { $sum: 1 }, ids: { $push: '$_id' }, amounts: { $addToSet: '$amountCents' },
        tenancyIds: { $addToSet: '$tenancyId' },
      } },
      { $match: { count: { $gt: 1 } } },
      { $limit: 30 },
    ], { allowDiskUse: true }).toArray();

    const indexes = await payments.listIndexes().toArray();
    const named = indexes.find((index) => index.name === TARGET.name) || null;
    const aligned = targetMatches(named);
    const conflictingSameKey = indexes.filter((index) => keyMatches(index.key, TARGET.key) && !targetMatches(index));
    const report = {
      database: mongoose.connection.name, collection: 'payments', readOnly: !EXECUTE,
      duplicateGroupCount: duplicateCount, duplicateSamples,
      targetIndex: named ? {
        name: named.name, key: named.key, unique: named.unique === true,
        partialFilterExpression: named.partialFilterExpression || null,
      } : null,
      conflictingSameKeyIndexes: conflictingSameKey.map((index) => ({
        name: index.name, key: index.key, unique: index.unique === true,
        partialFilterExpression: index.partialFilterExpression || null,
      })),
      targetAligned: aligned, executeRequested: EXECUTE,
    };

    if (!EXECUTE) {
      console.log(JSON.stringify(report, null, 2));
      console.log(duplicateCount ? 'BLOCKED: duplicate manual references require owner review.'
        : (aligned ? 'READY: target index already aligned.' : 'PREFLIGHT ONLY: no writes performed.'));
      return;
    }
    if (duplicateCount > 0) throw new Error(`Refusing index creation: ${duplicateCount} duplicate manual payment-reference groups exist`);
    if (conflictingSameKey.length) throw new Error('Refusing index creation: an index with the target key exists but has different options');
    if (!aligned) {
      await payments.createIndex(TARGET.key, {
        name: TARGET.name, unique: true, partialFilterExpression: TARGET.partialFilterExpression,
      });
    }
    const verified = (await payments.listIndexes().toArray()).find((index) => index.name === TARGET.name);
    if (!targetMatches(verified)) throw new Error('Created manual payment-reference index failed exact post-create verification');
    console.log(JSON.stringify({ ...report, readOnly: false, targetAligned: true, mutation: 'created_or_verified_exact_target_index' }, null, 2));
  } finally {
    await mongoose.disconnect();
  }
}

main().catch((error) => {
  console.error(`G3.3 MANUAL payment-reference index migration failed: ${error.message}`);
  process.exitCode = 1;
});
