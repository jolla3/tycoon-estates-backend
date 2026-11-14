import { evaluatePaymentIndexes, PAYMENT_RECEIPT_TENANCY_INDEX as CH, PAYMENT_CREDIT_KEY_INDEX as CR } from '../../../src/utils/paymentReceiptIndexReadiness.js';
import { assertSafeTarget, parseMongoUri, findExact } from '../../../scripts/migrations/lib/g5MigrationGuard.js';
import { config as payCfg } from '../../../scripts/migrations/20261113_g5_payment_receipt_tenancy_index.js';
import { config as colCfg } from '../../../scripts/migrations/20261113_g5_collection_indexes.js';

const good = [
  { name: CH.name, key: { ...CH.key }, unique: true, partialFilterExpression: { ...CH.partialFilterExpression } },
  { name: CR.name, key: { ...CR.key }, unique: true, partialFilterExpression: { creditApplicationKey: { $type: 'string' } } },
];
describe('Payment receipt index readiness', () => {
  test('aligned only with both new uniques and no legacy unique', () => {
    expect(evaluatePaymentIndexes(good).aligned).toBe(true);
    expect(evaluatePaymentIndexes([]).aligned).toBe(false);
    const legacy = [...good, { name: 'mpesaReceiptId_1', key: { mpesaReceiptId: 1 }, unique: true }];
    const r = evaluatePaymentIndexes(legacy);
    expect(r.aligned).toBe(false);
    expect(r.reasons.join()).toMatch(/legacy/);
  });
  test('non-unique legacy-named index does not block', () => {
    expect(evaluatePaymentIndexes([...good, { name: 'idx_payment_mpesa_receipt', key: { mpesaReceiptId: 1 }, sparse: true }]).aligned).toBe(true);
  });
  test('wrong partial filter or non-unique is misaligned', () => {
    expect(evaluatePaymentIndexes([{ ...good[0], partialFilterExpression: null }, good[1]]).aligned).toBe(false);
    expect(evaluatePaymentIndexes([{ ...good[0], unique: false }, good[1]]).aligned).toBe(false);
  });
});

describe('migration guards', () => {
  const save = { ...process.env };
  afterEach(() => { process.env = { ...save }; });
  test('dry run allowed for non-production DB, blocked for prod/system DBs', () => {
    expect(assertSafeTarget('mongodb://h:27017/tycoon_dev', false).dbName).toBe('tycoon_dev');
    for (const db of ['admin', 'local', 'tycoon_prod', 'live-db', 'production']) {
      expect(() => assertSafeTarget(`mongodb://h:27017/${db}`, false)).toThrow(/unsafe/);
    }
  });
  test('execute needs target, db allowlist and host allowlist', () => {
    const uri = 'mongodb://h1:27017/tycoon_stage';
    expect(() => assertSafeTarget(uri, true)).toThrow(/Refusing --execute/);
    process.env.G5_MIGRATION_TARGET_DB = 'tycoon_stage';
    process.env.G5_SAFE_DB_ALLOWLIST = 'tycoon_stage';
    expect(() => assertSafeTarget(uri, true)).toThrow(/HOST_ALLOWLIST/);
    process.env.G5_SAFE_MONGO_HOST_ALLOWLIST = 'other:27017';
    expect(() => assertSafeTarget(uri, true)).toThrow(/not allowlisted/);
    process.env.G5_SAFE_MONGO_HOST_ALLOWLIST = 'h1';
    expect(assertSafeTarget(uri, true).dbName).toBe('tycoon_stage');
  });
  test('uri parsing handles credentials and replica seeds', () => {
    expect(parseMongoUri('mongodb://u:p%40@a:1,b/db?x=1').hosts).toEqual(['a:1', 'b:27017']);
  });
  test('migration configs: payment migration drops only unique legacy receipt index; never touches MpesaTransaction receipt identity', () => {
    const drop = payCfg.drops[0];
    expect(drop.match({ unique: true, key: { mpesaReceiptId: 1 } })).toBe(true);
    expect(drop.match({ unique: false, key: { mpesaReceiptId: 1 } })).toBe(false);
    expect(drop.match({ unique: true, key: { mpesaReceiptId: 1, tenancyId: 1 } })).toBe(false);
    const all = [...payCfg.creates, ...colCfg.creates].map((c) => c.collection);
    expect(all).not.toContain('mpesatransactions');
    expect(payCfg.creates.every((c) => c.unique && c.partialFilterExpression)).toBe(true);
  });
  test('findExact is strict about key, unique and partial', () => {
    const c = payCfg.creates[0];
    expect(findExact([{ name: c.name, key: c.key, unique: true, partialFilterExpression: c.partialFilterExpression }], c)).toBeTruthy();
    expect(findExact([{ name: c.name, key: c.key, unique: true }], c)).toBeFalsy();
  });
});
