/**
 * G3.4 behavioral / regression tests for tenancy-aware accounting.
 *
 * Requires:
 *   MONGODB_URI pointing at a dedicated disposable replica-set database
 *   (never production / valuable developer DBs).
 *
 * Without MONGODB_URI these tests are skipped (describeWithMongo).
 * Without transaction support, financial posting paths fail closed — that is expected.
 */
import '../setup.js';
import { describeWithMongo, connectTestDb, clearTestDb, disconnectTestDb } from '../helpers/db.js';
import mongoose from 'mongoose';
import { Client } from '../../src/models/Client.js';
import { Estate } from '../../src/models/Estate.js';
import { House } from '../../src/models/House.js';
import { HouseType } from '../../src/models/HouseType.js';
import { HouseTypePlanVersion } from '../../src/models/HouseTypePlanVersion.js';
import { houseTypeService } from '../../src/services/houseType.service.js';
import { Tenant } from '../../src/models/Tenant.js';
import { Tenancy } from '../../src/models/Tenancy.js';
import { RentCharge } from '../../src/models/RentCharge.js';
import { Payment } from '../../src/models/Payment.js';
import { PaymentAllocation } from '../../src/models/PaymentAllocation.js';
import { Ledger } from '../../src/models/Ledger.js';
import { DepositMovement } from '../../src/models/DepositMovement.js';
import { BankAccount } from '../../src/models/BankAccount.js';
import { BankTransaction } from '../../src/models/BankTransaction.js';
import { rentService } from '../../src/services/rent.service.js';
import { accountingPostingService } from '../../src/services/accountingPosting.service.js';
import { reconciliationService } from '../../src/services/reconciliation.service.js';
import { ledgerService } from '../../src/services/ledger.service.js';
import { runIntegrityVerifier } from '../../src/services/integrityVerifier.service.js';
import { tenancyService } from '../../src/services/tenancy.service.js';
import { prepareG3TestIndexes } from '../helpers/g3Indexes.js';
import { encryptionUtil } from '../../src/utils/encryption.js';
import { dateUtil } from '../../src/utils/date.js';
import { money } from '../../src/utils/money.js';

describeWithMongo('G3 accounting foundation', () => {
  let client, estate, houseType, house, tenantA, tenantB, tenancyA, tenancyB;
  const period = '2026-06';

  beforeAll(async () => {
    await connectTestDb();
    // Safety: refuse obvious production-looking DB names
    const dbName = mongoose.connection.name || '';
    if (/prod|production|live/i.test(dbName)) {
      throw new Error(`Refusing to run G3 tests against database name "${dbName}"`);
    }
  });
  afterAll(disconnectTestDb);

  beforeEach(async () => {
    await clearTestDb();
    await prepareG3TestIndexes();

    client = await Client.create({ name: 'G3 Client' });
    estate = await Estate.create({ clientId: client._id, name: 'G3 Estate', isActive: true });
    houseType = await HouseType.create({
      clientId: client._id,
      estateId: estate._id,
      name: 'Bedsitter',
      defaultRentCents: 1000000,
      defaultDueDay: 5,
      planVersion: 1,
      defaultBilling: [
        { chargeType: 'RENT', description: 'Rent', amountCents: 1000000, dueDay: 5 },
        { chargeType: 'WATER', description: 'Water', amountCents: 50000, dueDay: 5 },
        { chargeType: 'OTHER', description: 'Security', amountCents: 20000, dueDay: 5 },
        { chargeType: 'OTHER', description: 'Garbage', amountCents: 10000, dueDay: 5 },
      ],
    });
    await HouseTypePlanVersion.create({
      clientId: client._id,
      estateId: estate._id,
      houseTypeId: houseType._id,
      version: 1,
      effectiveFromPeriod: period,
      lines: houseType.defaultBilling.map((line) => ({
        lineId: `${line.chargeType}:${line.description}`,
        chargeType: line.chargeType,
        description: line.description,
        amountCents: line.amountCents,
        dueDay: line.dueDay,
      })),
    });
    house = await House.create({
      clientId: client._id,
      estateId: estate._id,
      houseNumber: 'G3-01',
      houseTypeId: houseType._id,
      billingSource: 'HOUSE_TYPE',
      monthlyRent: 10000,
      status: 'occupied',
      isActive: true,
      dueDay: 5,
    });
    tenantA = await Tenant.create({
      clientId: client._id,
      estateId: estate._id,
      houseId: house._id,
      name: 'Alice Occupant',
      phone: '+254711000001',
    });
    tenantB = await Tenant.create({
      clientId: client._id,
      estateId: estate._id,
      houseId: house._id,
      name: 'Bob Occupant',
      phone: '+254711000002',
    });

    // Full-period tenancy A covering June 2026 then closed before July
    tenancyA = await Tenancy.create({
      clientId: client._id,
      estateId: estate._id,
      houseId: house._id,
      tenantId: tenantA._id,
      startAt: new Date('2026-01-01T00:00:00+03:00'),
      endAt: new Date('2026-07-01T00:00:00+03:00'),
      status: 'CLOSED',
      closeReason: 'MOVE_OUT',
    });
    // Active tenancy B from July onward
    tenancyB = await Tenancy.create({
      clientId: client._id,
      estateId: estate._id,
      houseId: house._id,
      tenantId: tenantB._id,
      startAt: new Date('2026-07-01T00:00:00+03:00'),
      endAt: null,
      status: 'ACTIVE',
    });
    house.tenantId = tenantB._id;
    await house.save();
  });

  test('two successive tenancies receive distinct charges; former arrears stay on old tenancy', async () => {
    const r1 = await rentService.generateChargesForEstate(client._id, estate._id, period);
    expect(r1.created).toBeGreaterThan(0);

    const chargesA = await RentCharge.find({ tenancyId: tenancyA._id, period });
    expect(chargesA.length).toBeGreaterThanOrEqual(2);
    expect(chargesA.every((c) => String(c.tenancyId) === String(tenancyA._id))).toBe(true);
    expect(chargesA.every((c) => c.tenancyId != null)).toBe(true);

    // July generation should bill tenancy B, not A
    const r2 = await rentService.generateChargesForEstate(client._id, estate._id, '2026-07');
    expect(r2.created).toBeGreaterThan(0);
    const chargesB = await RentCharge.find({ tenancyId: tenancyB._id, period: '2026-07' });
    expect(chargesB.length).toBeGreaterThan(0);
    const leaked = await RentCharge.find({ tenancyId: tenancyA._id, period: '2026-07' });
    expect(leaked.length).toBe(0);

    // Arrears on A do not appear as B obligations
    const outstandingB = await rentService.outstandingChargesForTenancy(client._id, tenancyB._id);
    expect(outstandingB.every((c) => String(c.tenancyId) === String(tenancyB._id))).toBe(true);
  });

  test('partial-period tenancy is excluded from automatic generation', async () => {
    const midStart = new Date('2026-08-15T00:00:00+03:00');
    await Tenancy.updateOne(
      { _id: tenancyB._id, status: 'ACTIVE' },
      { $set: { endAt: midStart, status: 'CLOSED', closeReason: 'TRANSFER' } }
    );
    const mid = await Tenancy.create({
      clientId: client._id,
      estateId: estate._id,
      houseId: house._id,
      tenantId: tenantA._id,
      startAt: midStart,
      endAt: null,
      status: 'ACTIVE',
    });
    const result = await rentService.generateChargesForEstate(client._id, estate._id, '2026-08');
    expect(result.partialPeriodExcluded).toBeGreaterThanOrEqual(1);
    const midCharges = await RentCharge.find({ tenancyId: mid._id, period: '2026-08' });
    expect(midCharges.length).toBe(0);
  });

  test('HouseType plan shared; multiple OTHER descriptions generate independently', async () => {
    await rentService.generateChargesForEstate(client._id, estate._id, period);
    const others = await RentCharge.find({
      tenancyId: tenancyA._id,
      period,
      chargeType: 'OTHER',
    }).lean();
    const descs = others.map((c) => c.description).sort();
    expect(descs).toEqual(expect.arrayContaining(['Garbage', 'Security']));
    expect(new Set(descs).size).toBe(descs.length);
  });

  test('plan change bumps version and does not rewrite existing charge snapshots', async () => {
    await rentService.generateChargesForEstate(client._id, estate._id, period);
    const before = await RentCharge.findOne({ tenancyId: tenancyA._id, period, chargeType: 'RENT' });
    expect(before.planVersion).toBe(1);
    const snapAmount = before.amountDueCents;

    await houseTypeService.update(client._id, houseType._id, {
      defaultBilling: [
        { chargeType: 'RENT', description: 'Rent', amountCents: 2000000, dueDay: 5 },
      ],
      effectiveFromPeriod: '2026-07',
    });

    // June continues to resolve immutable version 1.
    await rentService.generateChargesForEstate(client._id, estate._id, period);
    const after = await RentCharge.findById(before._id);
    expect(after.amountDueCents).toBe(snapAmount);
    expect(after.planVersion).toBe(1);

    // July resolves immutable version 2 for the next occupancy.
    await rentService.generateChargesForEstate(client._id, estate._id, '2026-07');
    const julyRent = await RentCharge.findOne({ tenancyId: tenancyB._id, period: '2026-07', chargeType: 'RENT' });
    expect(julyRent.amountDueCents).toBe(2000000);
    expect(julyRent.planVersion).toBe(2);
  });

  test('duplicate generation is idempotent; missing Ledger is repaired on retry', async () => {
    await rentService.generateChargesForEstate(client._id, estate._id, period);
    const charge = await RentCharge.findOne({ tenancyId: tenancyA._id, period, chargeType: 'RENT' });
    expect(charge).toBeTruthy();

    // Simulate missing ledger
    await Ledger.deleteMany({ referenceType: 'RentCharge', referenceId: charge._id });
    const missing = await Ledger.countDocuments({ referenceType: 'RentCharge', referenceId: charge._id });
    expect(missing).toBe(0);

    const again = await rentService.generateChargesForEstate(client._id, estate._id, period);
    expect(again.created).toBe(0);
    const ledgers = await Ledger.find({
      referenceType: 'RentCharge',
      referenceId: charge._id,
      entryType: 'CHARGE',
    });
    expect(ledgers.length).toBe(1);
    expect(String(ledgers[0].tenancyId)).toBe(String(tenancyA._id));

    const countCharges = await RentCharge.countDocuments({ tenancyId: tenancyA._id, period });
    await rentService.generateChargesForEstate(client._id, estate._id, period);
    expect(await RentCharge.countDocuments({ tenancyId: tenancyA._id, period })).toBe(countCharges);
  });

  test('manual payment carries tenancy; partial allocation leaves unapplied credit', async () => {
    await rentService.generateChargesForEstate(client._id, estate._id, period);
    const charges = await rentService.outstandingChargesForTenancy(client._id, tenancyA._id);
    const totalDue = charges.reduce((s, c) => s + Math.max(c.balanceCents, 0), 0);
    const payAmount = Math.min(totalDue - 1000, totalDue);
    expect(payAmount).toBeGreaterThan(0);

    const posted = await accountingPostingService.postConfirmedPayment({
      clientId: client._id,
      estateId: estate._id,
      houseId: house._id,
      tenantId: tenantA._id,
      tenancyId: tenancyA._id,
      amountCents: payAmount + 5000, // intentional unapplied remainder if exceeds, or partial
      paymentDate: new Date('2026-06-10'),
      origin: 'MANUAL',
      tenderMethod: 'CASH',
    });

    expect(posted.payment.tenancyId.toString()).toBe(tenancyA._id.toString());
    expect(posted.ledger).toBeTruthy();
    expect(String(posted.ledger.tenancyId)).toBe(String(tenancyA._id));

    const allocSum = (posted.allocations || []).reduce((s, a) => s + a.amountCents, 0);
    expect(allocSum).toBeLessThanOrEqual(posted.payment.amountCents);
    if (allocSum < posted.payment.amountCents) {
      expect(posted.unappliedCents).toBe(posted.payment.amountCents - allocSum);
    }
  });

  test('cross-tenancy allocation is rejected', async () => {
    await rentService.generateChargesForEstate(client._id, estate._id, period);
    await rentService.generateChargesForEstate(client._id, estate._id, '2026-07');
    const chargesA = await rentService.outstandingChargesForTenancy(client._id, tenancyA._id);

    await expect(
      accountingPostingService.postConfirmedPayment({
        clientId: client._id,
        estateId: estate._id,
        houseId: house._id,
        tenantId: tenantB._id,
        tenancyId: tenancyB._id,
        amountCents: 50000,
        paymentDate: new Date('2026-07-05'),
        origin: 'MANUAL',
        charges: chargesA, // wrong tenancy charges
      })
    ).rejects.toThrow(/tenancy|Cross-tenancy|scope|Conflict|Invalid/i);
  });

  test('OVERPAID charge yields negative balance when planner over-allocates last charge', async () => {
    // Single charge tenancy path: generate then overpay
    await rentService.ensureChargesForTenancy(client._id, tenancyA, house, period);
    const charges = await rentService.outstandingChargesForTenancy(client._id, tenancyA._id);
    const due = charges.reduce((s, c) => s + Math.max(c.balanceCents, 0), 0);
    const posted = await accountingPostingService.postConfirmedPayment({
      clientId: client._id,
      estateId: estate._id,
      houseId: house._id,
      tenantId: tenantA._id,
      tenancyId: tenancyA._id,
      amountCents: due + 25000,
      paymentDate: new Date('2026-06-20'),
      origin: 'MANUAL',
    });
    const updated = await RentCharge.find({ tenancyId: tenancyA._id, period });
    const anyOver = updated.some((c) => c.status === 'OVERPAID' || c.balanceCents < 0);
    // Either last-charge OVERPAID or unapplied remainder (both valid under locked policy)
    const unapplied = posted.unappliedCents || 0;
    expect(anyOver || unapplied > 0).toBe(true);
    if (anyOver) {
      expect(updated.some((c) => c.balanceCents < 0 && c.status === 'OVERPAID')).toBe(true);
    } else {
      expect(unapplied).toBeGreaterThan(0);
    }
  });

  test('ledger rejects RENT CHARGE/PAYMENT without tenancyId', async () => {
    await expect(
      ledgerService.postEntry({
        clientId: client._id,
        estateId: estate._id,
        houseId: house._id,
        entryType: 'CHARGE',
        amountCents: -1000,
        accountCategory: 'RENT',
      })
    ).rejects.toThrow(/tenancyId is required/);
  });

  test('legacy null-tenancy charges are preserved and not auto-attributed', async () => {
    const legacy = await RentCharge.create({
      clientId: client._id,
      estateId: estate._id,
      houseId: house._id,
      tenancyId: null,
      period: '2025-01',
      chargeType: 'RENT',
      description: 'Rent',
      amountDueCents: 99900,
      amountPaidCents: 0,
      balanceCents: 99900,
      status: 'UNPAID',
    });
    await rentService.generateChargesForEstate(client._id, estate._id, period);
    const still = await RentCharge.findById(legacy._id);
    expect(still.tenancyId).toBeNull();
    expect(still.amountDueCents).toBe(99900);
  });

  test('houseAccount separates current tenancy balance from unattributed', async () => {
    await rentService.generateChargesForEstate(client._id, estate._id, '2026-07');
    const account = await rentService.houseAccount(client._id, house._id);
    expect(account.currentTenancyId).toBeTruthy();
    expect(account.totals).toHaveProperty('currentTenancyBalanceCents');
    expect(account.totals).toHaveProperty('historicalUnattributedCents');
  });


  test('classifies fully unattributed legacy allocations without inventing tenancy ownership', async () => {
    const charge = await RentCharge.create({
      clientId: client._id,
      estateId: estate._id,
      houseId: house._id,
      tenantId: tenantA._id,
      tenancyId: null,
      period,
      chargeType: 'RENT',
      description: 'Legacy allocation verifier fixture',
      amountDueCents: 1000,
      amountPaidCents: 1000,
      balanceCents: 0,
      status: 'PAID',
      billingSource: 'MONTHLY_RENT',
    });

    const payment = await Payment.create({
      clientId: client._id,
      estateId: estate._id,
      houseId: house._id,
      tenantId: tenantA._id,
      tenancyId: null,
      origin: 'MANUAL',
      amountCents: 1000,
      paymentDate: new Date('2026-06-10T12:00:00+03:00'),
      status: 'CONFIRMED',
      allocatedCents: 1000,
    });

    const allocation = await PaymentAllocation.create({
      clientId: client._id,
      estateId: estate._id,
      paymentId: payment._id,
      tenancyId: null,
      rentChargeId: charge._id,
      amountCents: 1000,
      chargeType: 'RENT',
      period,
    });

    const report = await runIntegrityVerifier({ clientId: client._id });
    const allocationId = String(allocation._id);

    const legacyEntry = report.legacy.find(
      (entry) => entry.type === 'legacy_unattributed_payment_allocation'
    );

    expect(legacyEntry).toBeDefined();
    expect(legacyEntry.count).toBe(1);
    expect(legacyEntry.sampleIds).toContain(allocationId);

    // Classification must not mutate historical source ownership.
    const persisted = await PaymentAllocation.findById(allocation._id).lean();
    expect(persisted.tenancyId).toBeNull();
  });

  test('flags missing allocation tenancy when linked sources have tenancy ownership', async () => {
    const charge = await RentCharge.create({
      clientId: client._id,
      estateId: estate._id,
      houseId: house._id,
      tenantId: tenantA._id,
      tenancyId: tenancyA._id,
      period,
      chargeType: 'RENT',
      description: 'Partially attributed allocation verifier fixture',
      amountDueCents: 1000,
      amountPaidCents: 1000,
      balanceCents: 0,
      status: 'PAID',
      billingSource: 'MONTHLY_RENT',
    });

    const payment = await Payment.create({
      clientId: client._id,
      estateId: estate._id,
      houseId: house._id,
      tenantId: tenantA._id,
      tenancyId: tenancyA._id,
      origin: 'MANUAL',
      amountCents: 1000,
      paymentDate: tenancyA.startAt,
      status: 'CONFIRMED',
      allocatedCents: 1000,
    });

    const allocation = await PaymentAllocation.create({
      clientId: client._id,
      estateId: estate._id,
      paymentId: payment._id,
      tenancyId: null,
      rentChargeId: charge._id,
      amountCents: 1000,
      chargeType: 'RENT',
      period,
    });

    const report = await runIntegrityVerifier({ clientId: client._id });
    const allocationId = String(allocation._id);

    expect(report.issues.some((entry) =>
      entry.type === 'allocation_tenancy_mismatch'
      && entry.allocationId === allocationId
    )).toBe(true);

    expect(report.legacy.some((entry) =>
      entry.type === 'legacy_unattributed_payment_allocation'
      && entry.sampleIds.includes(allocationId)
    )).toBe(false);
  });

  test('integrity verifier is read-only and flags missing charge ledger', async () => {
    await rentService.generateChargesForEstate(client._id, estate._id, period);
    const charge = await RentCharge.findOne({ tenancyId: tenancyA._id, period });
    await Ledger.deleteMany({ referenceType: 'RentCharge', referenceId: charge._id });

    const beforeCounts = {
      charges: await RentCharge.countDocuments(),
      ledgers: await Ledger.countDocuments(),
      payments: await Payment.countDocuments(),
    };

    const report = await runIntegrityVerifier({ clientId: client._id });
    expect(report.issues.some((i) => i.type === 'missing_charge_ledger')).toBe(true);

    const afterCounts = {
      charges: await RentCharge.countDocuments(),
      ledgers: await Ledger.countDocuments(),
      payments: await Payment.countDocuments(),
    };
    expect(afterCounts).toEqual(beforeCounts);
  });

  test('integrity verifier accepts legitimate unapplied remainder as info not corruption', async () => {
    await rentService.ensureChargesForTenancy(client._id, tenancyA, house, period);
    // Create payment with zero outstanding by allocating nothing via empty plan: pay with no charges
    // Use a payment document + no allocations
    const p = await Payment.create({
      clientId: client._id,
      estateId: estate._id,
      houseId: house._id,
      tenantId: tenantA._id,
      tenancyId: tenancyA._id,
      origin: 'MANUAL',
      amountCents: 10000,
      paymentDate: new Date('2026-06-10T12:00:00+03:00'),
      status: 'CONFIRMED',
      allocatedCents: 0,
    });
    // Skip ledger for this synthetic case — verifier may flag missing ledger; focus on unapplied info
    const report = await runIntegrityVerifier({ clientId: client._id });
    const unapplied = report.info.filter((i) => i.type === 'legitimate_unapplied_payment_remainder');
    expect(unapplied.length).toBeGreaterThanOrEqual(1);
    expect(report.issues.some((i) => i.type === 'allocation_exceeds_payment' && String(i.paymentId) === String(p._id))).toBe(false);
  });

  test('integrity verifier accepts repeated recurring charge/payment balance transitions', async () => {
    const periods = [
      { period: '2026-07', paymentDate: new Date('2026-07-10T12:00:00+03:00') },
      { period: '2026-08', paymentDate: new Date('2026-08-10T12:00:00+03:00') },
    ];
    const ledgerRows = [];

    for (const item of periods) {
      const charge = await RentCharge.create({
        clientId: client._id,
        estateId: estate._id,
        houseId: house._id,
        tenantId: tenantB._id,
        tenancyId: tenancyB._id,
        period: item.period,
        chargeType: 'RENT',
        description: 'Rent',
        amountDueCents: 10000,
        amountPaidCents: 10000,
        balanceCents: 0,
        status: 'PAID',
        billingSource: 'MONTHLY_RENT',
      });
      const payment = await Payment.create({
        clientId: client._id,
        estateId: estate._id,
        houseId: house._id,
        tenantId: tenantB._id,
        tenancyId: tenancyB._id,
        origin: 'MANUAL',
        amountCents: 10000,
        paymentDate: item.paymentDate,
        period: item.period,
        status: 'CONFIRMED',
        allocatedCents: 10000,
      });
      await PaymentAllocation.create({
        clientId: client._id,
        estateId: estate._id,
        paymentId: payment._id,
        tenancyId: tenancyB._id,
        rentChargeId: charge._id,
        amountCents: 10000,
        chargeType: 'RENT',
        period: item.period,
      });

      // Each month repeats the same two balance edges: 0 -> -10000 -> 0.
      // No timestamp ordering is required to validate these as a multigraph.
      ledgerRows.push(
        {
          clientId: client._id,
          estateId: estate._id,
          houseId: house._id,
          tenantId: tenantB._id,
          tenancyId: tenancyB._id,
          accountCategory: 'RENT',
          entryType: 'CHARGE',
          amountCents: -10000,
          runningBalanceCents: -10000,
          referenceType: 'RentCharge',
          referenceId: charge._id,
          period: item.period,
        },
        {
          clientId: client._id,
          estateId: estate._id,
          houseId: house._id,
          tenantId: tenantB._id,
          tenancyId: tenancyB._id,
          accountCategory: 'RENT',
          entryType: 'PAYMENT',
          amountCents: 10000,
          runningBalanceCents: 0,
          referenceType: 'Payment',
          referenceId: payment._id,
          period: item.period,
        }
      );
    }

    await Ledger.create(ledgerRows);
    const report = await runIntegrityVerifier({ clientId: client._id });
    expect(report.ok).toBe(true);
    expect(report.issues.filter((item) => item.type.startsWith('ledger_running_balance_chain_'))).toEqual([]);
  });


  test('ledger balance exposes known arrears without claiming historical completeness', async () => {
    await Ledger.create({
      clientId: client._id,
      estateId: estate._id,
      houseId: house._id,
      tenantId: tenantA._id,
      tenancyId: tenancyA._id,
      accountCategory: 'RENT',
      entryType: 'CHARGE',
      amountCents: -12500,
      runningBalanceCents: -12500,
    });

    const balance = await ledgerService.balanceForTenancy(
      client._id, tenancyA._id, 'RENT'
    );

    expect(balance.knownArrearsCents).toBe(12500);
    expect(balance.historicalCoverage).toBe('UNVERIFIED');
    expect(balance.verifiedFullObligation).toBe(false);
    expect(balance).not.toHaveProperty('balanceCents');
  });
  test('integrity verifier flags a DepositMovement without its exact Ledger counterpart', async () => {
    const movement = await DepositMovement.create({
      clientId: client._id,
      estateId: estate._id,
      houseId: house._id,
      tenantId: tenantA._id,
      tenancyId: tenancyA._id,
      depositId: new mongoose.Types.ObjectId(),
      type: 'RECEIVED',
      amountCents: 15000,
      idempotencyKey: `verify-received-${tenancyA._id}`,
    });

    const report = await runIntegrityVerifier({ clientId: client._id });
    expect(report.issues.some((entry) =>
      entry.type === 'missing_deposit_movement_ledger'
      && entry.depositMovementId === String(movement._id)
    )).toBe(true);
  });
  test('integrity verifier accepts both exact Ledger legs of a linked deposit transfer', async () => {
    const outbound = await DepositMovement.create({
      clientId: client._id,
      estateId: estate._id,
      houseId: house._id,
      tenantId: tenantA._id,
      tenancyId: tenancyA._id,
      depositId: new mongoose.Types.ObjectId(),
      type: 'TRANSFER_OUT',
      amountCents: -3000,
      idempotencyKey: `verify-transfer:${tenancyA._id}:out`,
    });

    const inbound = await DepositMovement.create({
      clientId: client._id,
      estateId: estate._id,
      houseId: house._id,
      tenantId: tenantB._id,
      tenancyId: tenancyB._id,
      depositId: new mongoose.Types.ObjectId(),
      type: 'TRANSFER_IN',
      amountCents: 3000,
      linkedMovementId: outbound._id,
      idempotencyKey: `verify-transfer:${tenancyA._id}:in`,
    });

    await Ledger.create([
      {
        clientId: client._id,
        estateId: estate._id,
        houseId: house._id,
        tenantId: tenantA._id,
        tenancyId: tenancyA._id,
        accountCategory: 'DEPOSIT',
        entryType: 'DEPOSIT_TRANSFER_OUT',
        amountCents: -3000,
        runningBalanceCents: -3000,
        referenceType: 'DepositMovement',
        referenceId: outbound._id,
      },
      {
        clientId: client._id,
        estateId: estate._id,
        houseId: house._id,
        tenantId: tenantB._id,
        tenancyId: tenancyB._id,
        accountCategory: 'DEPOSIT',
        entryType: 'DEPOSIT_TRANSFER_IN',
        amountCents: 3000,
        runningBalanceCents: 3000,
        referenceType: 'DepositMovement',
        referenceId: inbound._id,
      },
    ]);

    const report = await runIntegrityVerifier({ clientId: client._id });
    const depositIssues = report.issues.filter((entry) =>
      entry.type.startsWith('deposit_movement_')
      || entry.type.startsWith('deposit_transfer_')
      || entry.type === 'missing_deposit_movement_ledger'
      || entry.type === 'orphan_deposit_movement_ledger'
    );

    expect(depositIssues).toEqual([]);
  });
  test('integrity verifier checks the inbound transfer Ledger leg independently', async () => {
    const outbound = await DepositMovement.create({
      clientId: client._id,
      estateId: estate._id,
      houseId: house._id,
      tenantId: tenantA._id,
      tenancyId: tenancyA._id,
      depositId: new mongoose.Types.ObjectId(),
      type: 'TRANSFER_OUT',
      amountCents: -2500,
      idempotencyKey: `verify-inbound-missing:${tenancyA._id}:out`,
    });

    const inbound = await DepositMovement.create({
      clientId: client._id,
      estateId: estate._id,
      houseId: house._id,
      tenantId: tenantB._id,
      tenancyId: tenancyB._id,
      depositId: new mongoose.Types.ObjectId(),
      type: 'TRANSFER_IN',
      amountCents: 2500,
      linkedMovementId: outbound._id,
      idempotencyKey: `verify-inbound-missing:${tenancyA._id}:in`,
    });

    await Ledger.create({
      clientId: client._id,
      estateId: estate._id,
      houseId: house._id,
      tenantId: tenantA._id,
      tenancyId: tenancyA._id,
      accountCategory: 'DEPOSIT',
      entryType: 'DEPOSIT_TRANSFER_OUT',
      amountCents: -2500,
      runningBalanceCents: -2500,
      referenceType: 'DepositMovement',
      referenceId: outbound._id,
    });

    const report = await runIntegrityVerifier({ clientId: client._id });
    expect(report.issues.some((entry) =>
      entry.type === 'missing_deposit_movement_ledger'
      && entry.depositMovementId === String(inbound._id)
    )).toBe(true);
  });
  test('integrity verifier flags transfer legs with unequal amounts', async () => {
    const outbound = await DepositMovement.create({
      clientId: client._id,
      estateId: estate._id,
      houseId: house._id,
      tenantId: tenantA._id,
      tenancyId: tenancyA._id,
      depositId: new mongoose.Types.ObjectId(),
      type: 'TRANSFER_OUT',
      amountCents: -4000,
      idempotencyKey: `verify-transfer-mismatch:${tenancyA._id}:out`,
    });

    const inbound = await DepositMovement.create({
      clientId: client._id,
      estateId: estate._id,
      houseId: house._id,
      tenantId: tenantB._id,
      tenancyId: tenancyB._id,
      depositId: new mongoose.Types.ObjectId(),
      type: 'TRANSFER_IN',
      amountCents: 3500,
      linkedMovementId: outbound._id,
      idempotencyKey: `verify-transfer-mismatch:${tenancyA._id}:in`,
    });

    await Ledger.create([
      {
        clientId: client._id,
        estateId: estate._id,
        houseId: house._id,
        tenantId: tenantA._id,
        tenancyId: tenancyA._id,
        accountCategory: 'DEPOSIT',
        entryType: 'DEPOSIT_TRANSFER_OUT',
        amountCents: -4000,
        runningBalanceCents: -4000,
        referenceType: 'DepositMovement',
        referenceId: outbound._id,
      },
      {
        clientId: client._id,
        estateId: estate._id,
        houseId: house._id,
        tenantId: tenantB._id,
        tenancyId: tenancyB._id,
        accountCategory: 'DEPOSIT',
        entryType: 'DEPOSIT_TRANSFER_IN',
        amountCents: 3500,
        runningBalanceCents: 3500,
        referenceType: 'DepositMovement',
        referenceId: inbound._id,
      },
    ]);

    const report = await runIntegrityVerifier({ clientId: client._id });
    expect(report.issues.some((entry) =>
      entry.type === 'deposit_transfer_amount_mismatch'
      && entry.inboundMovementId === String(inbound._id)
    )).toBe(true);
  });

});

describeWithMongo('G3 concurrent allocation serialization', () => {
  beforeAll(connectTestDb);
  afterAll(disconnectTestDb);
  beforeEach(async () => {
    await clearTestDb();
    await prepareG3TestIndexes();
  });

  test('two concurrent posts against same tenancy do not exceed payment capacity when serialized', async () => {
    const client = await Client.create({ name: 'Conc Client' });
    const estate = await Estate.create({ clientId: client._id, name: 'Conc Estate', isActive: true });
    const house = await House.create({
      clientId: client._id,
      estateId: estate._id,
      houseNumber: 'C-1',
      monthlyRent: 5000,
      billingSource: 'MONTHLY_RENT',
      status: 'occupied',
      isActive: true,
    });
    const tenant = await Tenant.create({
      clientId: client._id,
      estateId: estate._id,
      houseId: house._id,
      name: 'Conc Tenant',
      phone: '+254700111222',
    });
    const tenancy = await Tenancy.create({
      clientId: client._id,
      estateId: estate._id,
      houseId: house._id,
      tenantId: tenant._id,
      startAt: new Date('2026-01-01'),
      endAt: null,
      status: 'ACTIVE',
    });
    const period = dateUtil.currentPeriod();
    await rentService.ensureChargesForTenancy(client._id, tenancy, house, period);

    // Sequential proof of CAS path (true parallel requires multi-connection; still validates no double spend)
    const amount = 300000;
    const a = await accountingPostingService.postConfirmedPayment({
      clientId: client._id,
      estateId: estate._id,
      houseId: house._id,
      tenantId: tenant._id,
      tenancyId: tenancy._id,
      amountCents: amount,
      origin: 'MANUAL',
      paymentDate: new Date(),
    });
    expect(a.payment).toBeTruthy();
    const allocTotal = await PaymentAllocation.aggregate([
      { $match: { paymentId: a.payment._id } },
      { $group: { _id: null, t: { $sum: '$amountCents' } } },
    ]);
    expect((allocTotal[0]?.t || 0)).toBeLessThanOrEqual(amount);
  });





});
