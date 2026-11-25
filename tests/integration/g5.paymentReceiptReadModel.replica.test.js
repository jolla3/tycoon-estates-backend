/**
 * G5 canonical Payments receipt-envelope read model — replica-set acceptance.
 *
 * NOT EXECUTED while authoring. This test is destructive and is only enabled by
 * tests/helpers/db.js for an explicit disposable tycoon_test_* replica set:
 *   TYCOON_ALLOW_DESTRUCTIVE_TEST_DB=1
 *   MONGODB_URI='mongodb://127.0.0.1:27017/tycoon_test_payment_receipts?replicaSet=rs0'
 *   npm test -- tests/integration/g5.paymentReceiptReadModel.replica.test.js
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
import { RentCharge } from '../../src/models/RentCharge.js';
import { Payment } from '../../src/models/Payment.js';
import { PaymentAllocation } from '../../src/models/PaymentAllocation.js';
import { ManualReceipt } from '../../src/models/ManualReceipt.js';
import { BankTransaction } from '../../src/models/BankTransaction.js';
import { MpesaTransaction } from '../../src/models/MpesaTransaction.js';
import { TenantCreditMovement } from '../../src/models/TenantCreditMovement.js';
import { paymentService } from '../../src/services/payment.service.js';
import { PAYBILL_TYPE } from '../../src/services/mpesa/mpesaPosting.service.js';
import {
  ALLOCATION_STATE,
  TXN_VERIFICATION_STATE,
} from '../../src/services/mpesa/daraja.constants.js';

const date = (value) => new Date(value);
const objectId = () => new mongoose.Types.ObjectId();

describeWithMongo('G5 canonical Payments receipt-envelope read model', () => {
  let client;
  let estate;
  let houseA;
  let houseB;
  let tenant;
  let tenancyA;
  let tenancyB;
  let manualSurplus;
  let bankReceipt;
  let mpesaSurplus;
  let manualApplied;
  let unallocated;
  let failed;
  let endBoundary;

  const makeCharge = async ({ tenancy, house, period, description, amountCents }) => RentCharge.create({
    clientId: client._id,
    estateId: estate._id,
    houseId: house._id,
    tenantId: tenant._id,
    tenancyId: tenancy._id,
    period,
    chargeType: 'RENT',
    description,
    amountDueCents: amountCents,
    amountPaidCents: amountCents,
    balanceCents: 0,
    status: 'PAID',
  });

  const makePayment = async ({ origin, house, tenancy, amountCents, paymentDate, bankTransactionId = null, manualReceiptId = null }) => Payment.create({
    clientId: client._id,
    estateId: estate._id,
    houseId: house._id,
    tenantId: tenant._id,
    tenancyId: tenancy._id,
    origin,
    bankTransactionId,
    manualReceiptId,
    amountCents,
    paymentDate,
    status: 'CONFIRMED',
    tenderMethod: origin === 'CREDIT' ? null : (origin === 'BANK' ? 'BANK_TRANSFER' : 'CASH'),
  });

  const makeAllocation = async (payment, charge, amountCents) => PaymentAllocation.create({
    clientId: client._id,
    estateId: estate._id,
    paymentId: payment._id,
    tenancyId: charge.tenancyId,
    rentChargeId: charge._id,
    amountCents,
    chargeType: 'RENT',
    period: charge.period,
  });

  const makeMovement = async ({ movementType, amountCents, idempotencyKey, source, paymentId = null, tenancyId = null }) => TenantCreditMovement.create({
    clientId: client._id,
    estateId: estate._id,
    tenantId: tenant._id,
    movementType,
    amountCents,
    idempotencyKey,
    paymentId,
    tenancyId,
    ...(source || {}),
  });

  const makeMpesa = async ({ receiptNumber, eventAt, tenancy, postingState = 'POSTED', allocationState = ALLOCATION_STATE.BY_EVIDENCE }) => MpesaTransaction.create({
    clientId: client._id,
    merchantProfileId: objectId(),
    businessShortCode: '600123',
    receiptNumber,
    amountCents: 500,
    acceptedAmountCents: 500,
    currency: 'KES',
    transactionAt: eventAt,
    acceptedTransactionAt: eventAt,
    transactionType: PAYBILL_TYPE,
    verificationState: TXN_VERIFICATION_STATE.MATCHED,
    claimState: 'CLAIMED',
    postingState,
    allocationState,
    allocatedEstateId: estate._id,
    allocatedTenantId: tenant._id,
    allocatedTenancyId: tenancy._id,
    attributedClientId: client._id,
    attributedEstateId: estate._id,
    attributedTenantId: tenant._id,
    attributedTenancyId: tenancy._id,
    paymentIds: [],
    creditPaymentIds: [],
    creditMovementIds: [],
  });

  const makeBank = async ({ providerTransactionId, eventType = 'CREDIT', matchStatus = 'MATCHED', processingState = 'POSTED' }) => BankTransaction.create({
    clientId: client._id,
    estateId: estate._id,
    bankAccountId: objectId(),
    provider: 'TEST_BANK',
    providerTransactionId,
    amountCents: 1000,
    currency: 'KES',
    transactionDate: date('2026-09-20T10:00:00.000Z'),
    eventType,
    matchStatus,
    processingState,
    matchedHouseId: houseA._id,
    matchedTenantId: tenant._id,
    matchedTenancyId: tenancyA._id,
    paymentReference: providerTransactionId,
  });

  beforeAll(async () => {
    await connectTestDb();
    await clearTestDb();
    await prepareG3TestIndexes();
  });

  afterAll(async () => {
    await clearTestDb();
    await disconnectTestDb();
  });

  beforeEach(async () => {
    await clearTestDb();

    client = await Client.create({ name: 'G5 Receipt Read Model Client' });
    estate = await Estate.create({ clientId: client._id, name: 'G5 Receipt Read Model Estate' });
    houseA = await House.create({
      clientId: client._id, estateId: estate._id, houseNumber: 'A-01',
      monthlyRent: 2500, status: 'vacant', isActive: true, dueDay: 5,
    });
    houseB = await House.create({
      clientId: client._id, estateId: estate._id, houseNumber: 'B-02',
      monthlyRent: 5000, status: 'occupied', isActive: true, dueDay: 5,
    });
    tenant = await Tenant.create({
      clientId: client._id, estateId: estate._id, houseId: houseB._id,
      name: 'Historical Source Tenant', phone: null,
    });
    tenancyA = await Tenancy.create({
      clientId: client._id, estateId: estate._id, houseId: houseA._id, tenantId: tenant._id,
      startAt: date('2026-01-01T00:00:00.000Z'),
      endAt: date('2026-09-25T00:00:00.000Z'), status: 'CLOSED',
    });
    tenancyB = await Tenancy.create({
      clientId: client._id, estateId: estate._id, houseId: houseB._id, tenantId: tenant._id,
      startAt: date('2026-09-01T00:00:00.000Z'), endAt: null, status: 'ACTIVE',
    });

    // Earlier Manual receipt: entirely surplus, creating the KSh 50 credit
    // subsequently consumed by the Bank receipt.
    manualSurplus = await ManualReceipt.create({
      clientId: client._id, estateId: estate._id, houseId: houseA._id, tenantId: tenant._id,
      occupancyTenancyId: tenancyA._id,
      paymentDateLocal: '2026-09-15', paymentDate: date('2026-09-15T10:00:00.000Z'),
      period: '2026-09', tenderMethod: 'CASH', amountCents: 50,
      idempotencyKey: 'g5-ws5-manual-surplus', status: 'CONFIRMED',
      receiptAppliedCents: 0, creditAppliedCents: 0, newCreditCents: 50,
      creditBeforeCents: 0, creditRemainingCents: 0, creditAfterCents: 50,
      settlementVersion: 1, paymentIds: [], creditPaymentIds: [], creditMovementIds: [],
    });
    const manualSurplusMovement = await makeMovement({
      movementType: 'RECEIPT_SURPLUS', amountCents: 50,
      idempotencyKey: 'g5-ws5-manual-surplus-credit',
      source: { manualReceiptId: manualSurplus._id }, tenancyId: tenancyA._id,
    });
    await ManualReceipt.updateOne({ _id: manualSurplus._id }, { $set: { creditMovementIds: [manualSurplusMovement._id] } });

    // Bank envelope originates from the historical House A tenancy but is
    // allocated across obligations in Houses A and B. It consumes 50 cents of
    // existing credit and leaves 300 cents as new surplus.
    bankReceipt = await makeBank({ providerTransactionId: 'G5-WS5-BANK-001' });
    const bankChargeA = await makeCharge({ tenancy: tenancyA, house: houseA, period: '2026-09', description: 'Bank receipt source-house rent', amountCents: 250 });
    const bankChargeB = await makeCharge({ tenancy: tenancyB, house: houseB, period: '2026-10', description: 'Bank receipt destination-house rent', amountCents: 450 });
    const creditChargeB = await makeCharge({ tenancy: tenancyB, house: houseB, period: '2026-10', description: 'Existing credit destination rent', amountCents: 50 });
    const bankPaymentA = await makePayment({ origin: 'BANK', house: houseA, tenancy: tenancyA, amountCents: 250, paymentDate: bankReceipt.transactionDate, bankTransactionId: bankReceipt._id });
    const bankPaymentB = await makePayment({ origin: 'BANK', house: houseB, tenancy: tenancyB, amountCents: 450, paymentDate: bankReceipt.transactionDate, bankTransactionId: bankReceipt._id });
    const creditPayment = await makePayment({ origin: 'CREDIT', house: houseB, tenancy: tenancyB, amountCents: 50, paymentDate: bankReceipt.transactionDate });
    await Promise.all([
      makeAllocation(bankPaymentA, bankChargeA, 250),
      makeAllocation(bankPaymentB, bankChargeB, 450),
      makeAllocation(creditPayment, creditChargeB, 50),
    ]);
    const appliedMovement = await makeMovement({
      movementType: 'CREDIT_APPLIED', amountCents: -50,
      idempotencyKey: 'g5-ws5-bank-credit-applied',
      source: { bankTransactionId: bankReceipt._id },
      paymentId: creditPayment._id, tenancyId: tenancyB._id,
    });
    const bankSurplusMovement = await makeMovement({
      movementType: 'RECEIPT_SURPLUS', amountCents: 300,
      idempotencyKey: 'g5-ws5-bank-surplus-credit',
      source: { bankTransactionId: bankReceipt._id }, tenancyId: tenancyA._id,
    });
    await BankTransaction.updateOne({ _id: bankReceipt._id }, { $set: {
      paymentIds: [bankPaymentA._id, bankPaymentB._id],
      creditPaymentIds: [creditPayment._id],
      creditMovementIds: [appliedMovement._id, bankSurplusMovement._id],
      receiptAppliedCents: 700, creditAppliedCents: 50, newCreditCents: 300,
      creditBeforeCents: 50, creditRemainingCents: 0, creditAfterCents: 300,
      settlementVersion: 1,
    } });

    // Fully-surplus M-PESA receipt: no Payment child and no Allocation rows.
    mpesaSurplus = await makeMpesa({
      receiptNumber: 'G5WS5MPESA001', eventAt: date('2026-10-21T10:00:00.000Z'), tenancy: tenancyB,
    });
    const mpesaMovement = await makeMovement({
      movementType: 'RECEIPT_SURPLUS', amountCents: 500,
      idempotencyKey: 'g5-ws5-mpesa-surplus-credit',
      source: { mpesaTransactionId: mpesaSurplus._id }, tenancyId: tenancyB._id,
    });
    await MpesaTransaction.updateOne({ _id: mpesaSurplus._id }, { $set: {
      creditMovementIds: [mpesaMovement._id],
      receiptAppliedCents: 0, creditAppliedCents: 0, newCreditCents: 500,
      creditBeforeCents: 300, creditRemainingCents: 300, creditAfterCents: 800,
      creditEarnedCents: 500, settlementVersion: 1,
    } });

    // Later Manual receipt applies cash to a House B charge but does not spend
    // the existing tenant credit.
    manualApplied = await ManualReceipt.create({
      clientId: client._id, estateId: estate._id, houseId: houseB._id, tenantId: tenant._id,
      occupancyTenancyId: tenancyB._id,
      paymentDateLocal: '2026-10-22', paymentDate: date('2026-10-22T10:00:00.000Z'),
      period: '2026-10', tenderMethod: 'CASH', amountCents: 200,
      idempotencyKey: 'g5-ws5-manual-applied', status: 'CONFIRMED',
      receiptAppliedCents: 200, creditAppliedCents: 0, newCreditCents: 0,
      creditBeforeCents: 800, creditRemainingCents: 800, creditAfterCents: 800,
      settlementVersion: 1, paymentIds: [], creditPaymentIds: [], creditMovementIds: [],
    });
    const manualCharge = await makeCharge({ tenancy: tenancyB, house: houseB, period: '2026-10', description: 'Manual receipt applied rent', amountCents: 200 });
    const manualPayment = await makePayment({
      origin: 'MANUAL', house: houseB, tenancy: tenancyB, amountCents: 200,
      paymentDate: manualApplied.paymentDate, manualReceiptId: manualApplied._id,
    });
    await makeAllocation(manualPayment, manualCharge, 200);
    await ManualReceipt.updateOne({ _id: manualApplied._id }, { $set: { paymentIds: [manualPayment._id] } });

    // Deliberately orphaned CREDIT Payment: account activity, not a receipt.
    await makePayment({ origin: 'CREDIT', house: houseB, tenancy: tenancyB, amountCents: 25, paymentDate: date('2026-10-22T11:00:00.000Z') });

    // Invalid canonical-source states must not leak into the receipt list.
    unallocated = await makeMpesa({
      receiptNumber: 'G5WS5UNALLOC01', eventAt: date('2026-10-21T11:00:00.000Z'),
      tenancy: tenancyB, allocationState: ALLOCATION_STATE.UNALLOCATED,
    });
    failed = await makeMpesa({
      receiptNumber: 'G5WS5FAILED01', eventAt: date('2026-10-21T12:00:00.000Z'),
      tenancy: tenancyB, postingState: 'FAILED_TERMINAL',
    });
    endBoundary = await makeMpesa({
      receiptNumber: 'G5WS5BOUNDARY1', eventAt: date('2026-09-25T00:00:00.000Z'), tenancy: tenancyA,
    });
    expect([unallocated, failed, endBoundary].every(Boolean)).toBe(true);

    await makeBank({ providerTransactionId: 'G5-WS5-DEBIT-001', eventType: 'DEBIT' });
    await makeBank({ providerTransactionId: 'G5-WS5-UNMATCHED-001', matchStatus: 'UNMATCHED' });
    await makeBank({ providerTransactionId: 'G5-WS5-REVIEW-001', processingState: 'MANUAL_REVIEW' });
  });

  test('lists each received-money envelope once, including fully-surplus M-PESA, with exact split and credit reconciliation', async () => {
    const firstPage = await paymentService.list(client._id, null, { page: 1, limit: 2 });
    const secondPage = await paymentService.list(client._id, null, { page: 2, limit: 2 });

    expect(firstPage.pagination).toMatchObject({ page: 1, limit: 2, total: 4, totalPages: 2 });
    expect(secondPage.pagination).toMatchObject({ page: 2, limit: 2, total: 4, totalPages: 2 });
    expect(firstPage.items.map((row) => row.origin)).toEqual(['MANUAL', 'MPESA']);
    expect(secondPage.items.map((row) => row.origin)).toEqual(['BANK', 'MANUAL']);

    const bank = secondPage.items[0];
    expect(String(bank._id)).toBe(String(bankReceipt._id));
    expect(bank).toMatchObject({
      origin: 'BANK', source: 'BANK', listKind: 'payment', amountCents: 1000,
      receiptAppliedCents: 700, creditAppliedCents: 50, newCreditCents: 300,
      creditBeforeCents: 50, creditRemainingCents: 0, creditAfterCents: 300,
      receiptReconciliation: 'VERIFIED', creditReconciliation: 'VERIFIED', settlementIdentity: 'VERIFIED',
      houseNumber: 'A-01', sourceTenancyStatus: 'VERIFIED',
    });
    expect(bank.paymentIds).toHaveLength(2);
    expect(bank.creditPaymentIds).toHaveLength(1);
    expect(bank.allocationBreakdown).toHaveLength(3);
    expect(bank.allocationBreakdown.map((row) => row.houseNumber).sort()).toEqual(['A-01', 'B-02', 'B-02']);
    expect(bank.allocationBreakdown.filter((row) => row.fundingSource === 'EXISTING_CREDIT')).toHaveLength(1);

    const mpesa = firstPage.items[1];
    expect(String(mpesa._id)).toBe(String(mpesaSurplus._id));
    expect(mpesa).toMatchObject({
      origin: 'MPESA', listKind: 'payment', amountCents: 500, paymentIds: [], creditPaymentIds: [],
      receiptAppliedCents: 0, creditAppliedCents: 0, newCreditCents: 500,
      creditBeforeCents: 300, creditRemainingCents: 300, creditAfterCents: 800,
      receiptReconciliation: 'VERIFIED', creditReconciliation: 'VERIFIED', settlementIdentity: 'VERIFIED',
      houseNumber: 'B-02',
    });

    const manualSurplusRow = secondPage.items[1];
    expect(String(manualSurplusRow._id)).toBe(String(manualSurplus._id));
    expect(manualSurplusRow).toMatchObject({
      listKind: 'manual_receipt', amountCents: 50, receiptAppliedCents: 0, newCreditCents: 50,
      receiptReconciliation: 'VERIFIED', creditReconciliation: 'VERIFIED', settlementIdentity: 'VERIFIED',
      houseNumber: 'A-01',
    });

    const positions = firstPage.items.map((row) => row.currentAccountPosition);
    expect(positions.every((position) => position?.balanceScope === 'CURRENT')).toBe(true);
    expect(positions.every((position) => position?.creditCents === 800 && position?.outstandingCents === 0 && position?.netCents === 800)).toBe(true);
    const allRows = [...firstPage.items, ...secondPage.items];
    expect(allRows.some((row) => [unallocated, failed, endBoundary].some((source) => String(row._id) === String(source._id)))).toBe(false);
  });

  test('includes a manual receipt when its Tenancy begins later on the same Nairobi calendar day', async () => {
    // ManualReceipt.paymentDate is a stable noon-Nairobi representative of
    // paymentDateLocal, not the provider/operator's exact transaction time.
    await Tenancy.updateOne(
      { _id: tenancyB._id },
      { $set: { startAt: date('2026-09-01T20:00:00.000Z') } }
    );

    const receipt = await ManualReceipt.create({
      clientId: client._id,
      estateId: estate._id,
      houseId: houseB._id,
      tenantId: tenant._id,
      occupancyTenancyId: tenancyB._id,
      paymentDateLocal: '2026-09-01',
      paymentDate: date('2026-09-01T09:00:00.000Z'), // 12:00 Africa/Nairobi
      period: '2026-09',
      tenderMethod: 'MPESA',
      amountCents: 100,
      idempotencyKey: 'g5-ws5-manual-same-day-after-noon',
      status: 'CONFIRMED',
      receiptAppliedCents: 0,
      creditAppliedCents: 0,
      newCreditCents: 100,
      creditBeforeCents: 800,
      creditRemainingCents: 800,
      creditAfterCents: 900,
      settlementVersion: 1,
      paymentIds: [],
      creditPaymentIds: [],
      creditMovementIds: [],
    });
    const movement = await makeMovement({
      movementType: 'RECEIPT_SURPLUS',
      amountCents: 100,
      idempotencyKey: 'g5-ws5-manual-same-day-after-noon-credit',
      source: { manualReceiptId: receipt._id },
      tenancyId: tenancyB._id,
    });
    await ManualReceipt.updateOne(
      { _id: receipt._id },
      { $set: { creditMovementIds: [movement._id] } }
    );

    const manualOnly = await paymentService.list(client._id, null, {
      page: 1,
      limit: 20,
      origin: 'MANUAL',
    });
    expect(manualOnly.items.some((row) => String(row._id) === String(receipt._id))).toBe(true);
  });

  test('uses immutable source House filters and excludes CREDIT rows, unallocated M-PESA, Bank debits and reviews', async () => {
    const bankOnly = await paymentService.list(client._id, [estate._id], { page: 1, limit: 20, origin: 'BANK' });
    expect(bankOnly.items).toHaveLength(1);
    expect(String(bankOnly.items[0]._id)).toBe(String(bankReceipt._id));

    const sourceHouseA = await paymentService.list(client._id, null, { page: 1, limit: 20, houseId: String(houseA._id) });
    expect(sourceHouseA.items.map((row) => String(row._id)).sort()).toEqual([String(bankReceipt._id), String(manualSurplus._id)].sort());
    expect(sourceHouseA.items.every((row) => row.houseNumber === 'A-01')).toBe(true);

    const manualOnly = await paymentService.list(client._id, null, { page: 1, limit: 20, origin: 'MANUAL' });
    expect(manualOnly.items).toHaveLength(2);
    expect(manualOnly.items.every((row) => row.origin === 'MANUAL')).toBe(true);
  });
});
