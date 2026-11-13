/**
 * Shared guard + runner for G5 index migrations.
 * Dry-run by default. --execute requires G5_/G3_ SAFE_DB_ALLOWLIST, *_MIGRATION_TARGET_DB (== URI db)
 * and *_SAFE_MONGO_HOST_ALLOWLIST. Never run against production by this repository's tooling.
 */
import mongoose from 'mongoose';

const env = (a, b) => String(process.env[a] || process.env[b] || '').trim();
const list = (v) => v.split(',').map((s) => s.trim().toLowerCase()).filter(Boolean);
const withPort = (a) => (a.includes(':') ? a : `${a}:27017`);

export function parseMongoUri(uri) {
  const m = /^(mongodb(?:\+srv)?:\/\/)(.*)$/i.exec(String(uri || ''));
  if (!m) throw new Error('MONGODB_URI must use mongodb:// or mongodb+srv://');
  const rest = m[2];
  const end = rest.search(/[/?#]/);
  if (end < 0) throw new Error('MONGODB_URI must include a database name');
  const authority = rest.slice(0, end);
  const dbName = decodeURIComponent(rest.slice(end).split(/[?#]/, 1)[0].replace(/^\/+/, '').split('/')[0]);
  if (!dbName) throw new Error('MONGODB_URI must include a database name');
  const hosts = authority.slice(authority.lastIndexOf('@') + 1).split(',').map((s) => withPort(s.trim().toLowerCase())).filter(Boolean);
  return { dbName, hosts };
}

export function assertSafeTarget(uri, execute) {
  const parsed = parseMongoUri(uri);
  const { dbName, hosts } = parsed;
  if (/^(admin|local|config)$/i.test(dbName) || /(?:^|[^a-z0-9])(?:prod(?:uction)?|live)(?:$|[^a-z0-9])/i.test(dbName)) {
    throw new Error(`Refusing unsafe database name "${dbName}"`);
  }
  if (!execute) return parsed;
  const dbs = new Set(list(env('G5_SAFE_DB_ALLOWLIST', 'G3_SAFE_DB_ALLOWLIST')));
  const target = env('G5_MIGRATION_TARGET_DB', 'G3_MIGRATION_TARGET_DB');
  if (!target || target !== dbName || !dbs.has(dbName.toLowerCase())) {
    throw new Error('Refusing --execute: target DB must equal *_MIGRATION_TARGET_DB and be in *_SAFE_DB_ALLOWLIST');
  }
  const allowed = new Set(list(env('G5_SAFE_MONGO_HOST_ALLOWLIST', 'G3_SAFE_MONGO_HOST_ALLOWLIST')).map(withPort));
  if (!allowed.size) throw new Error('Refusing --execute: *_SAFE_MONGO_HOST_ALLOWLIST is required');
  const bad = hosts.filter((h) => !allowed.has(h));
  if (bad.length) throw new Error(`Refusing --execute: host(s) not allowlisted: ${bad.join(', ')}`);
  return parsed;
}

const sameKey = (a, b) => JSON.stringify(a) === JSON.stringify(b);
export function findExact(indexes, spec) {
  return indexes.find((i) => i.name === spec.name && sameKey(i.key, spec.key)
    && Boolean(i.unique) === Boolean(spec.unique)
    && JSON.stringify(i.partialFilterExpression || null) === JSON.stringify(spec.partialFilterExpression || null));
}

/**
 * @param {object} cfg { title, creates: [{collection, name, key, unique, partialFilterExpression}],
 *   drops: [{collection, match(idx)=>bool}], preflight(db)=>[{check, samples}], verify?(db)=>Promise<string[]> }
 */
export async function runIndexMigration(cfg, { argv = process.argv, uri = process.env.MONGODB_URI } = {}) {
  const execute = argv.includes('--execute');
  const target = assertSafeTarget(uri, execute);
  console.log(JSON.stringify({ migration: cfg.title, phase: 'preflight', dbName: target.dbName, execute }));
  await mongoose.connect(uri);
  try {
    const db = mongoose.connection.db;
    const dupes = await cfg.preflight(db);
    const blocking = dupes.filter((d) => d.samples.length);
    if (blocking.length) {
      console.error(JSON.stringify({ error: 'preflight_duplicates_present', blocking }));
      process.exitCode = 2;
      return { status: 'blocked', blocking };
    }
    const plan = [];
    for (const d of cfg.drops) {
      const idx = (await db.collection(d.collection).indexes().catch(() => [])).filter(d.match);
      for (const i of idx) plan.push({ op: 'drop', collection: d.collection, name: i.name });
    }
    for (const c of cfg.creates) {
      const idx = await db.collection(c.collection).indexes().catch(() => []);
      if (!findExact(idx, c)) plan.push({ op: 'create', collection: c.collection, name: c.name });
    }
    console.log(JSON.stringify({ plan, mode: execute ? 'execute' : 'dry_run' }));
    if (!execute) return { status: 'dry_run', plan };
    for (const p of plan.filter((x) => x.op === 'drop')) await db.collection(p.collection).dropIndex(p.name);
    for (const c of cfg.creates) {
      const idx = await db.collection(c.collection).indexes().catch(() => []);
      if (findExact(idx, c)) continue;
      const opts = { name: c.name, unique: Boolean(c.unique) };
      if (c.partialFilterExpression) opts.partialFilterExpression = c.partialFilterExpression;
      await db.collection(c.collection).createIndex(c.key, opts);
    }
    const problems = [];
    for (const c of cfg.creates) {
      if (!findExact(await db.collection(c.collection).indexes(), c)) problems.push(`missing ${c.name}`);
    }
    if (cfg.verify) problems.push(...await cfg.verify(db));
    if (problems.length) { process.exitCode = 3; console.error(JSON.stringify({ error: 'post_verification_failed', problems })); return { status: 'verify_failed', problems }; }
    console.log(JSON.stringify({ status: 'executed_verified' }));
    return { status: 'executed_verified' };
  } finally {
    await mongoose.disconnect();
  }
}

export async function dupGroups(db, collection, match, id) {
  return db.collection(collection).aggregate([
    { $match: match }, { $group: { _id: id, n: { $sum: 1 } } }, { $match: { n: { $gt: 1 } } }, { $limit: 20 },
  ]).toArray();
}
