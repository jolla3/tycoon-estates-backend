/**
 * G5 M-PESA historical source-tenancy attribution — MongoDB replica-set tests.
 *
 * NOT EXECUTED in the authoring environment. Run only against the repository's
 * dedicated disposable tycoon_test_* replica set with:
 *   TYCOON_ALLOW_DESTRUCTIVE_TEST_DB=1
 *   MONGODB_URI='mongodb://127.0.0.1:27017/tycoon_test_mpesa_tenancy?replicaSet=rs0'
 *   npm test -- tests/integration/g5.mpesaPostingTenancy.replica.test.js
 *
 * These cases prove the source tenancy is persisted on first claim and
 * revalidated after the shared allocator has acquired its Tenant/Tenancy fences.
 */
import '../setup.js';
import mongoose from 'mongoose';
import {
  describeWithMongo,
  connectTestDb,
  clearTestDb,
  disconnectTestDb,
} from '../helpers/db.js';
import { prepareG3TestIndexes } from '../helpers/g3Indexes.js';
import { Client } from '../../src/models/Client.js';
import { Estate } from '../../src/models/Estate.js';
import { House } from '../../src/models/House.js';
import { Tenant } from '../../src/models/Tenant.js';
import { Tenancy } from '../../src/models/Tenancy.js';
import { Payment } from '../../src/models/Payment.js';
import { PaymentAllocation } from '../../src/models/PaymentAllocation.js';
import { Ledger } from '../../src/models/Ledger.js';
import { TenantCreditMovement } from '../../src/models/TenantCreditMovement.js';
import { MpesaTransaction } from '../../src/models/MpesaTransaction.js';
import { MpesaCollectionReference } from '../../src/models/MpesaCollectionReference.js';
import {
  executeFencedPosting,
  PAYBILL_TYPE,
} from '../../src/services/mpesa/mpesaPosting.service.js';
import {
  ALLOCATION_STATE,
  TXN_VERIFICATION_STATE,
} from '../../src/services/mpesa/daraja.constants.js';
import {
  PAYMENT_RECEIPT_TENANCY_INDEX,
  PAYMENT_CREDIT_KEY_INDEX,
} from '../../src/utils/paymentReceiptIndexReadiness.js';

describeWithMongo('G5 M-PESA historical source-tenancy posting fence', () => {
  let client;
  let estate;
  let house;
  let tenant;
  let tenancy;
  let reference;
  let txn;
  let eventAt;
  let merchantProfileId;

  beforeAll(async () => {
    await connectTestDb();
    await clearTestDb();
    await prepareG3TestIndexes();

    // Migration-controlled receipt/credit child identities for this disposable DB only.
    await Payment.collection.createIndex(
      PAYMENT_RECEIPT_TENANCY_INDEX.key,
      {
        name: PAYMENT_RECEIPT_TENANCY_INDEX.name,
        unique: true,
        partialFilterExpression: PAYMENT_RECEIPT_TENANCY_INDEX.partialFilterExpression,
      }
    );
    await Payment.collection.createIndex(
      PAYMENT_CREDIT_KEY_INDEX.key,
      {
        name: PAYMENT_CREDIT_KEY_INDEX.name,
        unique: true,
        partialFilterExpression: PAYMENT_CREDIT_KEY_INDEX.partialFilterExpression,
      }
    );
    await TenantCreditMovement.createIndexes();
    await MpesaTransaction.createIndexes();
    await MpesaCollectionReference.createIndexes();
  });

  afterAll(async () => {
    await clearTestDb();
    await disconnectTestDb();
  });

  beforeEach(async () => {
    await clearTestDb();

    client = await Client.create({ name: 'M-PESA source tenancy test client' });
    estate = await Estate.create({
      clientId: client._id,
      name: 'M-PESA Source Tenancy Estate',
      isActive: true,
    });
    house = await House.create({
      clientId: client._id,
      estateId: estate._id,
      houseNumber: 'MPESA-01',
      monthlyRent: 10000,
      status: 'occupied',
      isActive: true,
      dueDay: 5,
    });
    tenant = await Tenant.create({
      clientId: client._id,
      estateId: estate._id,
      houseId: house._id,
      name: 'M-PESA Source Tenant',
      phone: null,
    });
    eventAt = new Date('2026-10-20T12:15:30.000Z');
    tenancy = await Tenancy.create({
      clientId: client._id,
      estateId: estate._id,
      houseId: house._id,
      tenantId: tenant._id,
      startAt: new Date('2026-01-01T00:00:00.000Z'),
      endAt: null,
      status: 'ACTIVE',
    });

    merchantProfileId = new mongoose.Types.ObjectId();
    reference = await MpesaCollectionReference.create({
      merchantProfileId,
      clientId: client._id,
      estateId: estate._id,
      tenantId: tenant._id,
      tenancyId: tenancy._id,
      reference: 'TPOSTING001',
      status: 'ACTIVE',
    });
    txn = await MpesaTransaction.create({
      clientId: client._id,
      merchantProfileId,
      businessShortCode: '600123',
      receiptNumber: 'R' + new mongoose.Types.ObjectId().toString().slice(-9),
      amountCents: 1500,
      acceptedAmountCents: 1500,
      currency: 'KES',
      transactionAt: eventAt,
      acceptedTransactionAt: eventAt,
      transactionType: PAYBILL_TYPE,
      verificationState: TXN_VERIFICATION_STATE.MATCHED,
      claimState: 'UNCLAIMED',
      postingState: 'NOT_POSTED',
      allocationState: ALLOCATION_STATE.BY_REFERENCE,
      allocationReferenceId: reference._id,
      allocatedEstateId: estate._id,
      allocatedTenantId: tenant._id,
      allocatedTenancyId: tenancy._id,
    });
  });

  const post = (sourceTenancy = tenancy) => executeFencedPosting({
    txn,
    clientId: client._id,
    estateId: estate._id,
    tenantId: tenant._id,
    actorUserId: null,
    ipAddress: '127.0.0.1',
    sourceTenancy: typeof sourceTenancy.toObject === 'function'
      ? sourceTenancy.toObject()
      : sourceTenancy,
    sourceHouse: house.toObject(),
    evidence: {
      type: 'PAYBILL_REFERENCE',
      reference: reference.toObject(),
    },
  });

  test('posts one verified receipt with its exact source tenancy pinned to the canonical envelope', async () => {
    const result = await post();

    expect(result.reused).toBe(false);
    expect(result.newCreditCents).toBe(1500);
    expect(result.paymentIds).toEqual([]);

    const saved = await MpesaTransaction.findById(txn._id).select('+postingLeaseToken').lean();
    expect(saved.postingState).toBe('POSTED');
    expect(saved.claimState).toBe('CLAIMED');
    expect(String(saved.attributedClientId)).toBe(String(client._id));
    expect(String(saved.attributedEstateId)).toBe(String(estate._id));
    expect(String(saved.attributedTenantId)).toBe(String(tenant._id));
    expect(String(saved.attributedTenancyId)).toBe(String(tenancy._id));
    expect(saved.postingLeaseToken).toBeNull();

    const movements = await TenantCreditMovement.find({ mpesaTransactionId: txn._id }).lean();
    expect(movements).toHaveLength(1);
    expect(movements[0].movementType).toBe('RECEIPT_SURPLUS');
    expect(movements[0].amountCents).toBe(1500);
    expect(await Payment.countDocuments({ mpesaReceiptId: txn._id })).toBe(0);
    expect(await PaymentAllocation.countDocuments({})).toBe(0);
    expect(await Ledger.countDocuments({})).toBe(0);
  });

  test('a PayBill reference retired after evidence evaluation cannot post or create credit', async () => {
    // Keep the ACTIVE reference document snapshot, but retire its database row
    // before the posting transaction re-reads the immutable reference identity.
    const retired = await MpesaCollectionReference.updateOne(
      { _id: reference._id, status: 'ACTIVE' },
      { $set: { status: 'RETIRED', retiredAt: new Date(), retiredReason: 'ADMIN' } }
    );
    expect(retired.matchedCount).toBe(1);

    await expect(post()).rejects.toMatchObject({
      code: 'COLLECTION_REFERENCE_REQUIRES_REVIEW',
    });

    const saved = await MpesaTransaction.findById(txn._id).select('+postingLeaseToken').lean();
    expect(saved.postingState).toBe('FAILED_TERMINAL');
    expect(saved.claimState).toBe('REVIEW');
    expect(saved.allocationReason).toBe('COLLECTION_REFERENCE_CHANGED_DURING_POSTING');
    expect(saved.postingFailureCode).toBe('COLLECTION_REFERENCE_REQUIRES_REVIEW');
    expect(saved.postingLeaseToken).toBeNull();
    expect(await Payment.countDocuments({})).toBe(0);
    expect(await PaymentAllocation.countDocuments({})).toBe(0);
    expect(await Ledger.countDocuments({})).toBe(0);
    expect(await TenantCreditMovement.countDocuments({ mpesaTransactionId: txn._id })).toBe(0);
  });

  test('a tenancy closed after the evidence snapshot fails inside settlement and leaves no financial rows', async () => {
    // The posting caller holds a stale ACTIVE evidence snapshot. The canonical
    // source tenancy is closed before the posting transaction starts, while the
    // transaction timestamp remains inside its historical [startAt, endAt) interval.
    const staleTenancy = tenancy.toObject();
    const closedAt = new Date(eventAt.getTime() + 60_000);
    const changed = await Tenancy.updateOne(
      { _id: tenancy._id, status: 'ACTIVE' },
      {
        $set: { status: 'CLOSED', endAt: closedAt, closeReason: 'MOVE_OUT' },
        $inc: { ledgerRev: 1 },
      }
    );
    expect(changed.matchedCount).toBe(1);

    await expect(post(staleTenancy)).rejects.toMatchObject({
      code: 'SOURCE_TENANCY_REQUIRES_REVIEW',
    });

    const saved = await MpesaTransaction.findById(txn._id).select('+postingLeaseToken').lean();
    expect(saved.postingState).toBe('FAILED_TERMINAL');
    expect(saved.claimState).toBe('REVIEW');
    expect(saved.allocationReason).toBe('SOURCE_TENANCY_CHANGED_DURING_POSTING');
    expect(saved.postingLeaseToken).toBeNull();
    expect(saved.attributedTenancyId).toEqual(tenancy._id);

    expect(await Payment.countDocuments({})).toBe(0);
    expect(await PaymentAllocation.countDocuments({})).toBe(0);
    expect(await Ledger.countDocuments({})).toBe(0);
    expect(await TenantCreditMovement.countDocuments({ mpesaTransactionId: txn._id })).toBe(0);
  });
});
