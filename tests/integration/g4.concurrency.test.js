/**
 * Database-backed concurrency tests for G4 claims, fences, and idempotency.
 * Requires MONGODB_URI pointing at a disposable database.
 * Skips when URI is missing or looks like production.
 */
import '../setup.js';
import mongoose from 'mongoose';
import {
  connectTestDb,
  disconnectTestDb,
} from '../helpers/db.js';
import { BankTransaction } from '../../src/models/BankTransaction.js';
import { BankAccount } from '../../src/models/BankAccount.js';
import {
  claimBankTransaction,
  failClaim,
} from '../../src/services/banking/processingClaim.js';
import {
  acquireSyncLease,
  advanceCheckpoint,
  releaseSyncLease,
} from '../../src/services/banking/syncCoordination.service.js';

// The shared helper enforces explicit opt-in, a tycoon_test_*
// database name, replica-set/sharded topology and transaction support.
const canRun = Boolean(process.env.MONGODB_URI)
  && process.env.TYCOON_ALLOW_DESTRUCTIVE_TEST_DB === '1';

const describeDb = canRun ? describe : describe.skip;

const testRunId = new mongoose.Types.ObjectId().toString();
const createdTransactionRefs = new Set();
const createdAccountHashes = new Set();

function transactionRef(label) {
  const ref = `g4-${testRunId}-${label}`;
  createdTransactionRefs.add(ref);
  return ref;
}

function accountHash(label) {
  const hash = `g4-${testRunId}-${label}`;
  createdAccountHashes.add(hash);
  return hash;
}

async function cleanupOwnFixtures() {
  if (mongoose.connection.readyState !== 1) return;

  const transactionRefs = [...createdTransactionRefs];
  const accountHashes = [...createdAccountHashes];

  await Promise.all([
    transactionRefs.length
      ? BankTransaction.deleteMany({
          provider: 'COOP',
          providerTransactionId: { $in: transactionRefs },
        })
      : Promise.resolve(),
    accountHashes.length
      ? BankAccount.deleteMany({
          provider: 'COOP',
          accountNumberHash: { $in: accountHashes },
        })
      : Promise.resolve(),
  ]);
}

describeDb('G4 Mongo concurrency (disposable DB)', () => {
  beforeAll(async () => {
    await connectTestDb();

    // Integration tests connect directly to MongoDB and bypass application
    // startup. Install and verify the schema indexes used by production's
    // ensureIndexes() before testing transaction idempotency.
    await BankTransaction.createIndexes();

    const indexes = await BankTransaction.collection.indexes();
    const providerIdentityIndex = indexes.find((index) => (
      index.key
      && index.key.provider === 1
      && index.key.providerTransactionId === 1
      && Object.keys(index.key).length === 2
    ));

    if (!providerIdentityIndex?.unique) {
      throw new Error(
        'Required unique BankTransaction { provider, providerTransactionId } index is missing'
      );
    }

    console.log('PASS: unique provider transaction identity index verified');
  }, 30000);

  afterAll(async () => {
    try {
      await cleanupOwnFixtures();
    } finally {
      await disconnectTestDb();
    }
  }, 30000);

  test('compound unique index enforces one provider transaction', async () => {
    const clientId = new mongoose.Types.ObjectId();
    const estateId = new mongoose.Types.ObjectId();
    const bankAccountId = new mongoose.Types.ObjectId();
    const base = {
      clientId,
      estateId,
      bankAccountId,
      provider: 'COOP',
      providerTransactionId: transactionRef('unique'),
      amountCents: 1000,
      currency: 'KES',
      transactionDate: new Date(),
      eventType: 'CREDIT',
      processingState: 'RECEIVED',
    };
    await BankTransaction.create(base);
    await expect(BankTransaction.create(base)).rejects.toMatchObject({ code: 11000 });
  });

  test('only one of two concurrent claims wins', async () => {
    const doc = await BankTransaction.create({
      clientId: new mongoose.Types.ObjectId(),
      estateId: new mongoose.Types.ObjectId(),
      bankAccountId: new mongoose.Types.ObjectId(),
      provider: 'COOP',
      providerTransactionId: transactionRef('claim'),
      amountCents: 500,
      currency: 'KES',
      transactionDate: new Date(),
      eventType: 'CREDIT',
      processingState: 'RECEIVED',
    });
    const [a, b] = await Promise.all([
      claimBankTransaction(doc._id, { claimToken: 'tok-a' }),
      claimBankTransaction(doc._id, { claimToken: 'tok-b' }),
    ]);
    const winners = [a, b].filter((x) => x.claimed);
    expect(winners).toHaveLength(1);
  });

  test('stale claim owner cannot fail a newer claim', async () => {
    const doc = await BankTransaction.create({
      clientId: new mongoose.Types.ObjectId(),
      estateId: new mongoose.Types.ObjectId(),
      bankAccountId: new mongoose.Types.ObjectId(),
      provider: 'COOP',
      providerTransactionId: transactionRef('stale'),
      amountCents: 500,
      currency: 'KES',
      transactionDate: new Date(),
      eventType: 'CREDIT',
      processingState: 'RECEIVED',
    });
    const first = await claimBankTransaction(doc._id, {
      claimToken: 'old',
      ttlMs: 1,
    });
    expect(first.claimed).toBe(true);
    await new Promise((r) => setTimeout(r, 5));
    const second = await claimBankTransaction(doc._id, { claimToken: 'new', ttlMs: 60_000 });
    expect(second.claimed).toBe(true);
    const failed = await failClaim(doc._id, 'old', { errorMessage: 'stale' });
    expect(failed).toBeNull();
    const current = await BankTransaction.findById(doc._id);
    expect(current.processingClaimToken).toBe('new');
  });

  test('sync lease fence blocks stale checkpoint advance', async () => {
    const account = await BankAccount.create({
      clientId: new mongoose.Types.ObjectId(),
      estateId: new mongoose.Types.ObjectId(),
      provider: 'COOP',
      accountNumberEncrypted: 'x',
      accountNumberHash: accountHash('sync-account'),
      accountName: 'T',
      connectionStatus: 'connected',
    });
    const lease1 = await acquireSyncLease(account._id, { workerId: 'w1', ttlMs: 60_000 });
    await releaseSyncLease(account._id, {
      workerId: 'w1',
      fenceGeneration: lease1.fenceGeneration,
    });
    // Expire by setting past lease then acquire as w2
    await BankAccount.updateOne(
      { _id: account._id },
      { $set: { 'sync.leaseExpiresAt': new Date(Date.now() - 1000), 'sync.leaseOwner': null } }
    );
    const lease2 = await acquireSyncLease(account._id, { workerId: 'w2', ttlMs: 60_000 });
    expect(lease2.fenceGeneration).toBeGreaterThan(lease1.fenceGeneration);
    const staleAdvance = await advanceCheckpoint(account._id, {
      workerId: 'w1',
      fenceGeneration: lease1.fenceGeneration,
      checkpoint: { type: 'date_window', value: { end: 'x' }, acceptedThrough: new Date() },
    });
    expect(staleAdvance).toBe(false);
    const okAdvance = await advanceCheckpoint(account._id, {
      workerId: 'w2',
      fenceGeneration: lease2.fenceGeneration,
      checkpoint: { type: 'date_window', value: { end: 'y' }, acceptedThrough: new Date() },
    });
    expect(okAdvance).toBe(true);
  });
});

describe('G4 concurrency gate', () => {
  test('documents whether DB tests ran', () => {
    if (!canRun) {
      console.warn(
        'G4 concurrency tests SKIPPED — set MONGODB_URI and '
        + 'TYCOON_ALLOW_DESTRUCTIVE_TEST_DB=1 for a dedicated '
        + 'tycoon_test_* replica-set database'
      );
    }
    expect(true).toBe(true);
  });
});
