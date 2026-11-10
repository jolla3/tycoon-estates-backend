/**
 * G3.5 read-only financial integrity verifier.
 * Never writes, repairs, or creates indexes.
 */
import { RentCharge } from '../models/RentCharge.js';
import { Payment } from '../models/Payment.js';
import { PaymentAllocation } from '../models/PaymentAllocation.js';
import { Ledger } from '../models/Ledger.js';
import { Tenancy } from '../models/Tenancy.js';
import { BankTransaction } from '../models/BankTransaction.js';
import { DepositMovement } from '../models/DepositMovement.js';
import { inspectLedgerBalanceChains } from '../utils/ledgerBalanceChain.js';

const asId = (value) => value == null ? null : String(value?._id ?? value);
const sameId = (a, b) => asId(a) === asId(b);
const safeInteger = (value) => Number.isSafeInteger(value);
const sampleIds = (docs, n = 5) => (docs || []).slice(0, n).map((d) => String(d._id || d.id || d));
const keyOf = (...parts) => JSON.stringify(parts.map((p) => p == null ? null : String(p)));

function issue(list, severity, type, payload = {}) {
  list.push({ severity, type, ...payload });
}

function pushLegacy(list, type, docs) {
  if (docs.length) {
    list.push({ severity: 'info', type, count: docs.length, sampleIds: sampleIds(docs) });
  }
}

function tenancyScopeMatches(source, tenancy) {
  return Boolean(tenancy)
    && sameId(source.clientId, tenancy.clientId)
    && sameId(source.estateId, tenancy.estateId)
    && sameId(source.houseId, tenancy.houseId)
    && sameId(source.tenantId, tenancy.tenantId);
}

function ledgerScopeMismatch(source, ledger) {
  const fields = ['clientId', 'estateId', 'houseId', 'tenancyId'];
  if (source.tenantId != null) fields.push('tenantId');
  return fields.filter((field) => !sameId(source[field], ledger[field]));
}

function sourceLedgerKey(referenceType, referenceId, entryType) {
  return keyOf(referenceType, referenceId, entryType);
}

const DEPOSIT_MOVEMENT_ENTRY_TYPES = Object.freeze({
  RECEIVED: 'DEPOSIT_RECEIVED',
  DEDUCTION: 'DEPOSIT_DEDUCTION',
  REFUND: 'DEPOSIT_REFUND',
  TRANSFER_OUT: 'DEPOSIT_TRANSFER_OUT',
  TRANSFER_IN: 'DEPOSIT_TRANSFER_IN',
});

export async function runIntegrityVerifier({ clientId = null } = {}) {
  const issues = [];
  const info = [];
  const legacy = [];
  const chargeFilter = clientId ? { clientId } : {};
  const paymentFilter = clientId ? { clientId } : {};

  const [charges, payments] = await Promise.all([
    RentCharge.find(chargeFilter).lean(),
    Payment.find(paymentFilter).lean(),
  ]);
  const chargeIds = charges.map((d) => d._id);
  const paymentIds = payments.map((d) => d._id);

  // Include allocations linked to in-scope sources even when the allocation's
  // own clientId was corrupted. This avoids hiding ownership drift by filtering
  // solely on the allocation's denormalized clientId.
  const allocationFilter = clientId
    ? { $or: [
      { clientId },
      ...(paymentIds.length ? [{ paymentId: { $in: paymentIds } }] : []),
      ...(chargeIds.length ? [{ rentChargeId: { $in: chargeIds } }] : []),
    ] }
    : {};
  const allocations = await PaymentAllocation.find(allocationFilter).lean();

  const linkedPaymentIds = [...new Map(
    [...paymentIds, ...allocations.map((a) => a.paymentId).filter(Boolean)].map((id) => [asId(id), id])
  ).values()];
  const linkedChargeIds = [...new Map(
    [...chargeIds, ...allocations.map((a) => a.rentChargeId).filter(Boolean)].map((id) => [asId(id), id])
  ).values()];

  const [linkedPayments, linkedCharges] = await Promise.all([
    linkedPaymentIds.length ? Payment.find({ _id: { $in: linkedPaymentIds } }).lean() : [],
    linkedChargeIds.length ? RentCharge.find({ _id: { $in: linkedChargeIds } }).lean() : [],
  ]);
  const paymentById = new Map(linkedPayments.map((p) => [asId(p._id), p]));
  const chargeById = new Map(linkedCharges.map((c) => [asId(c._id), c]));

  const attributedChargeIds = [...charges, ...linkedCharges].filter((c) => c.tenancyId).map((c) => c.tenancyId);
  const attributedPaymentIds = [...payments, ...linkedPayments].filter((p) => p.tenancyId).map((p) => p.tenancyId);
  const allocationTenancyIds = allocations.filter((a) => a.tenancyId).map((a) => a.tenancyId);
  const tenancyIds = [...new Map(
    [...attributedChargeIds, ...attributedPaymentIds, ...allocationTenancyIds]
      .map((id) => [asId(id), id])
  ).values()];
  const tenancies = tenancyIds.length
    ? await Tenancy.find({ _id: { $in: tenancyIds } }).lean()
    : [];
  const tenancyById = new Map(tenancies.map((t) => [asId(t._id), t]));

  // --- RentCharge identities, amount validity, Tenancy ownership and ledger ---
  const unattrCharges = charges.filter((c) => !c.tenancyId);
  pushLegacy(legacy, 'legacy_unattributed_rent_charge', unattrCharges);

  const chargeIdentityMap = new Map();
  for (const c of charges) {
    if (!c.tenancyId) continue;
    const identity = keyOf(c.tenancyId, c.period, c.chargeType, c.description || '');
    const group = chargeIdentityMap.get(identity) || [];
    group.push(c);
    chargeIdentityMap.set(identity, group);
  }
  for (const [identity, group] of chargeIdentityMap) {
    if (group.length > 1) {
      issue(issues, 'critical', 'duplicate_tenancy_charge_identity', {
        identity, count: group.length, sampleIds: sampleIds(group),
      });
    }
  }

  const allocationsByCharge = new Map();
  const allocationsByPayment = new Map();
  for (const a of allocations) {
    const chargeKey = asId(a.rentChargeId);
    const paymentKey = asId(a.paymentId);
    if (chargeKey) {
      const list = allocationsByCharge.get(chargeKey) || [];
      list.push(a);
      allocationsByCharge.set(chargeKey, list);
    }
    if (paymentKey) {
      const list = allocationsByPayment.get(paymentKey) || [];
      list.push(a);
      allocationsByPayment.set(paymentKey, list);
    }
  }

  for (const c of charges) {
    if (!safeInteger(c.amountDueCents) || c.amountDueCents <= 0) {
      issue(issues, 'high', 'invalid_rent_charge_amount', {
        rentChargeId: String(c._id), amountDueCents: c.amountDueCents,
      });
    }
    if (!safeInteger(c.amountPaidCents) || c.amountPaidCents < 0) {
      issue(issues, 'high', 'invalid_rent_charge_paid_projection', {
        rentChargeId: String(c._id), amountPaidCents: c.amountPaidCents,
      });
    }
    const chargeAllocations = allocationsByCharge.get(asId(c._id)) || [];
    const paidSum = chargeAllocations.reduce((sum, a) => sum + (safeInteger(a.amountCents) ? a.amountCents : 0), 0);
    if (c.amountPaidCents !== paidSum) {
      issue(issues, 'high', 'charge_paid_projection_mismatch', {
        rentChargeId: String(c._id), amountPaidCents: c.amountPaidCents, allocationSum: paidSum,
      });
    }
    const expectedBalance = c.amountDueCents - paidSum;
    if (c.balanceCents !== expectedBalance) {
      issue(issues, 'high', 'charge_balance_projection_mismatch', {
        rentChargeId: String(c._id), balanceCents: c.balanceCents, expected: expectedBalance,
      });
    }
    if (safeInteger(expectedBalance) && expectedBalance < 0) {
      info.push({ severity: 'info', type: 'legitimate_overpaid_charge', rentChargeId: String(c._id), balanceCents: expectedBalance });
    }
    if (!c.tenancyId) continue;

    const tenancy = tenancyById.get(asId(c.tenancyId));
    if (!tenancy) {
      issue(issues, 'high', 'rent_charge_missing_tenancy_record', {
        rentChargeId: String(c._id), tenancyId: String(c.tenancyId),
      });
    } else if (!tenancyScopeMatches(c, tenancy)) {
      issue(issues, 'critical', 'rent_charge_tenancy_scope_mismatch', {
        rentChargeId: String(c._id), tenancyId: String(c.tenancyId),
      });
    }

  }

  // --- Payments and exact BankTransaction linkage ---
  const unattrPayments = payments.filter((p) => !p.tenancyId);
  for (const p of unattrPayments) {
    legacy.push({ severity: 'info', type: 'legacy_unattributed_payment', paymentId: String(p._id) });
  }

  const bankIds = linkedPayments
    .filter((p) => p.origin === 'BANK' && p.bankTransactionId)
    .map((p) => p.bankTransactionId);
  const bankFilter = clientId
    ? { $or: [{ clientId }, ...(bankIds.length ? [{ _id: { $in: bankIds } }] : [])] }
    : {};
  const bankTransactions = await BankTransaction.find(bankFilter).lean();
  const bankById = new Map(bankTransactions.map((b) => [asId(b._id), b]));
  const paymentsByBankId = new Map();
  for (const p of linkedPayments.filter((p) => p.origin === 'BANK' && p.bankTransactionId)) {
    const key = asId(p.bankTransactionId);
    const group = paymentsByBankId.get(key) || [];
    group.push(p);
    paymentsByBankId.set(key, group);
  }
  for (const bank of bankTransactions) {
    if (bank.matchStatus === 'MATCHED') {
      const linked = paymentsByBankId.get(asId(bank._id)) || [];
      const confirmed = linked.filter((p) => p.status === 'CONFIRMED');
      if (confirmed.length !== 1) {
        issue(issues, 'high', 'matched_bank_transaction_payment_link_count', {
          bankTransactionId: String(bank._id), confirmedPaymentCount: confirmed.length,
          linkedPaymentCount: linked.length,
        });
      }
      if (bank.eventType !== 'CREDIT' || !safeInteger(bank.amountCents) || bank.amountCents <= 0
        || bank.processingState !== 'POSTED' || !bank.matchedHouseId
        || !bank.matchedTenantId || !bank.matchedTenancyId) {
        issue(issues, 'high', 'matched_bank_transaction_state_or_identity_invalid', {
          bankTransactionId: String(bank._id), eventType: bank.eventType,
          amountCents: bank.amountCents, processingState: bank.processingState,
        });
      }
    } else if (bank.processingState === 'POSTED') {
      issue(issues, 'high', 'posted_bank_transaction_not_matched', {
        bankTransactionId: String(bank._id), matchStatus: bank.matchStatus,
      });
    }
  }

  for (const p of payments) {
    if (!safeInteger(p.amountCents) || p.amountCents <= 0) {
      issue(issues, 'high', 'invalid_payment_amount', { paymentId: String(p._id), amountCents: p.amountCents });
    }
    if (p.status === 'CONFIRMED' && !p.origin) {
      issue(issues, 'medium', 'payment_missing_origin', { paymentId: String(p._id) });
    }
    if (p.origin === 'BANK') {
      if (!p.bankTransactionId) {
        issue(issues, 'high', 'bank_payment_missing_transaction_link', { paymentId: String(p._id) });
      } else {
        const bank = bankById.get(asId(p.bankTransactionId));
        if (!bank) {
          issue(issues, 'high', 'bank_payment_missing_transaction', { paymentId: String(p._id), bankTransactionId: String(p.bankTransactionId) });
        } else if (!sameId(bank.clientId, p.clientId)
          || !sameId(bank.estateId, p.estateId)
          || !sameId(bank.matchedHouseId, p.houseId)
          || (p.tenancyId && (!sameId(bank.matchedTenantId, p.tenantId)
            || !sameId(bank.matchedTenancyId, p.tenancyId)))
          || bank.eventType !== 'CREDIT'
          || bank.amountCents !== p.amountCents
          || bank.matchStatus !== 'MATCHED'
          || (p.tenancyId && bank.processingState !== 'POSTED')) {
          issue(issues, 'critical', 'bank_payment_transaction_scope_mismatch', {
            paymentId: String(p._id), bankTransactionId: String(bank._id),
          });
        }
      }
    }

    if (p.tenancyId) {
      const tenancy = tenancyById.get(asId(p.tenancyId));
      if (!tenancy) {
        issue(issues, 'high', 'payment_missing_tenancy_record', {
          paymentId: String(p._id), tenancyId: String(p.tenancyId),
        });
      } else if (!tenancyScopeMatches(p, tenancy)) {
        issue(issues, 'critical', 'payment_tenancy_scope_mismatch', {
          paymentId: String(p._id), tenancyId: String(p.tenancyId),
        });
      } else {
        const paidAt = p.paymentDate ? new Date(p.paymentDate).getTime() : NaN;
        const startsAt = tenancy.startAt ? new Date(tenancy.startAt).getTime() : NaN;
        const endsAt = tenancy.endAt ? new Date(tenancy.endAt).getTime() : null;
        if (Number.isFinite(paidAt) && Number.isFinite(startsAt)
          && (paidAt < startsAt || (endsAt != null && paidAt >= endsAt))) {
          issue(issues, 'high', 'payment_date_outside_tenancy', {
            paymentId: String(p._id), tenancyId: String(p.tenancyId), paymentDate: p.paymentDate,
          });
        }
      }
    }

    const paymentAllocations = allocationsByPayment.get(asId(p._id)) || [];
    const allocatedSum = paymentAllocations.reduce((sum, a) => sum + (safeInteger(a.amountCents) ? a.amountCents : 0), 0);
    if (allocatedSum > p.amountCents) {
      issue(issues, 'critical', 'allocation_exceeds_payment', {
        paymentId: String(p._id), amountCents: p.amountCents, allocationSum: allocatedSum,
      });
    } else if (safeInteger(p.amountCents) && allocatedSum < p.amountCents) {
      info.push({ severity: 'info', type: 'legitimate_unapplied_payment_remainder', paymentId: String(p._id), unappliedCents: p.amountCents - allocatedSum });
    }
  }

  // --- Allocations: full denormalized scope, exact Tenancy and source pairing ---
  const allocationPairMap = new Map();
  const unattributedLegacyAllocations = [];
  for (const a of allocations) {
    if (!safeInteger(a.amountCents) || a.amountCents <= 0) {
      issue(issues, 'high', 'invalid_allocation_amount', { allocationId: String(a._id), amountCents: a.amountCents });
    }
    const pair = keyOf(a.paymentId, a.rentChargeId);
    const pairGroup = allocationPairMap.get(pair) || [];
    pairGroup.push(a);
    allocationPairMap.set(pair, pairGroup);

    const payment = paymentById.get(asId(a.paymentId));
    const charge = chargeById.get(asId(a.rentChargeId));
    if (!payment || !charge) {
      issue(issues, 'critical', 'orphan_allocation', {
        allocationId: String(a._id), missingPayment: !payment, missingCharge: !charge,
      });
      continue;
    }

    // Preserve fully unattributed historical allocations as legacy records.
    // Never infer tenancy ownership from the current house occupant.
    // Existing ownership and tenancy mismatch checks still run below.
    if (
      a.tenancyId == null
      && payment.tenancyId == null
      && charge.tenancyId == null
    ) {
      unattributedLegacyAllocations.push(a);
    }

    const sourceScopesMatch = sameId(payment.clientId, charge.clientId)
      && sameId(payment.estateId, charge.estateId)
      && sameId(payment.houseId, charge.houseId)
      && sameId(payment.tenancyId, charge.tenancyId);
    const allocationScopeMatches = sameId(a.clientId, payment.clientId)
      && sameId(a.clientId, charge.clientId)
      && sameId(a.estateId, payment.estateId)
      && sameId(a.estateId, charge.estateId);
    if (!sourceScopesMatch || !allocationScopeMatches) {
      issue(issues, 'critical', 'allocation_ownership_mismatch', {
        allocationId: String(a._id), paymentId: String(payment._id), rentChargeId: String(charge._id),
      });
    }
    if (!sameId(a.tenancyId, payment.tenancyId) || !sameId(a.tenancyId, charge.tenancyId)) {
      issue(issues, 'critical', 'allocation_tenancy_mismatch', { allocationId: String(a._id) });
    }
    if (String(a.period || '') !== String(charge.period || '')
      || String(a.chargeType || '') !== String(charge.chargeType || 'RENT')) {
      issue(issues, 'high', 'allocation_charge_descriptor_mismatch', {
        allocationId: String(a._id), rentChargeId: String(charge._id),
      });
    }
    if (a.tenancyId) {
      const tenancy = tenancyById.get(asId(a.tenancyId));
      if (!tenancy) {
        issue(issues, 'high', 'allocation_missing_tenancy_record', { allocationId: String(a._id), tenancyId: String(a.tenancyId) });
      } else if (!sameId(tenancy.clientId, a.clientId)
        || !sameId(tenancy.estateId, a.estateId)
        || !sameId(tenancy.houseId, payment.houseId)
        || (payment.tenantId != null && !sameId(tenancy.tenantId, payment.tenantId))
        || (charge.tenantId != null && !sameId(tenancy.tenantId, charge.tenantId))) {
        issue(issues, 'critical', 'allocation_tenancy_scope_mismatch', { allocationId: String(a._id) });
      }
    }
  }
  pushLegacy(
    legacy,
    'legacy_unattributed_payment_allocation',
    unattributedLegacyAllocations,
  );

  for (const [pair, group] of allocationPairMap) {
    if (group.length > 1) {
      issue(issues, 'high', 'duplicate_allocation_pair', { pair, count: group.length, sampleIds: sampleIds(group) });
    }
  }

  // --- Ledger source checks and running balance sequence ---
  // Load movements belonging to the requested client or to a tenancy already
  // discovered through the rent/payment source records. Transfer relationships
  // pull in the opposite leg even if its denormalized ownership fields are bad.
  const movementFilter = clientId
    ? { $or: [
      { clientId },
      ...(tenancyIds.length ? [{ tenancyId: { $in: tenancyIds } }] : []),
    ] }
    : {};
  const initialDepositMovements = await DepositMovement.find(movementFilter).lean();

  const parentMovementIds = [...new Map(
    initialDepositMovements
      .filter((m) => m.type === 'TRANSFER_IN' && m.linkedMovementId)
      .map((m) => [asId(m.linkedMovementId), m.linkedMovementId])
  ).values()];
  const outboundMovementIds = initialDepositMovements
    .filter((m) => m.type === 'TRANSFER_OUT')
    .map((m) => m._id);

  const [linkedMovementParents, linkedMovementChildren] = await Promise.all([
    parentMovementIds.length
      ? DepositMovement.find({ _id: { $in: parentMovementIds } }).lean()
      : [],
    outboundMovementIds.length
      ? DepositMovement.find({ linkedMovementId: { $in: outboundMovementIds } }).lean()
      : [],
  ]);

  const depositMovementById = new Map();
  for (const movement of [
    ...initialDepositMovements,
    ...linkedMovementParents,
    ...linkedMovementChildren,
  ]) {
    depositMovementById.set(asId(movement._id), movement);
  }
  const depositMovements = [...depositMovementById.values()];
  const depositMovementIds = depositMovements.map((m) => m._id);

  // Include the movement's Tenancy in the verifier's ownership map.
  const movementTenancyIds = [...new Map(
    depositMovements
      .filter((m) => m.tenancyId)
      .map((m) => [asId(m.tenancyId), m.tenancyId])
  ).values()];
  const missingMovementTenancyIds = movementTenancyIds
    .filter((id) => !tenancyById.has(asId(id)));
  if (missingMovementTenancyIds.length) {
    const movementTenancies = await Tenancy.find({
      _id: { $in: missingMovementTenancyIds },
    }).lean();
    for (const tenancy of movementTenancies) {
      tenancyById.set(asId(tenancy._id), tenancy);
      tenancies.push(tenancy);
    }
  }

  const sourceIds = [...chargeIds, ...paymentIds];
  const ledgerTenancyScopeIds = [...new Map(
    [...tenancyIds, ...movementTenancyIds]
      .map((id) => [asId(id), id])
  ).values()];

  const ledgerFilter = clientId
    ? { $or: [
      { clientId },
      ...(sourceIds.length ? [{ referenceId: { $in: sourceIds } }] : []),
      ...(ledgerTenancyScopeIds.length
        ? [{ tenancyId: { $in: ledgerTenancyScopeIds } }]
        : []),
      ...(depositMovementIds.length ? [{
        referenceType: 'DepositMovement',
        referenceId: { $in: depositMovementIds },
      }] : []),
    ] }
    : {};
  const ledgers = await Ledger.find(ledgerFilter).lean();
  const ledgerTenancyIds = [...new Map(
    ledgers.filter((l) => l.tenancyId).map((l) => [asId(l.tenancyId), l.tenancyId])
  ).values()];
  const notYetLoadedTenancyIds = ledgerTenancyIds.filter((id) => !tenancyById.has(asId(id)));
  if (notYetLoadedTenancyIds.length) {
    const extraTenancies = await Tenancy.find({ _id: { $in: notYetLoadedTenancyIds } }).lean();
    for (const t of extraTenancies) {
      tenancyById.set(asId(t._id), t);
      tenancies.push(t);
    }
  }

  // --- DepositMovement: exact Ledger counterpart and transfer-pair integrity ---
  const depositLedgersByMovement = new Map();
  const depositLedgerRows = ledgers.filter(
    (row) => row.referenceType === 'DepositMovement' && row.referenceId
  );

  for (const row of depositLedgerRows) {
    const key = asId(row.referenceId);
    const group = depositLedgersByMovement.get(key) || [];
    group.push(row);
    depositLedgersByMovement.set(key, group);
  }

  for (const movement of depositMovements) {
    const movementId = asId(movement._id);
    const expectedEntryType = DEPOSIT_MOVEMENT_ENTRY_TYPES[movement.type];

    if (!expectedEntryType) {
      issue(issues, 'high', 'deposit_movement_invalid_type', {
        depositMovementId: movementId,
        movementType: movement.type,
      });
    }

    if (!safeInteger(movement.amountCents) || movement.amountCents === 0) {
      issue(issues, 'high', 'deposit_movement_invalid_amount', {
        depositMovementId: movementId,
        amountCents: movement.amountCents,
      });
    } else {
      const expectsPositive = ['RECEIVED', 'TRANSFER_IN'].includes(movement.type);
      const expectsNegative = ['DEDUCTION', 'REFUND', 'TRANSFER_OUT'].includes(movement.type);
      if ((expectsPositive && movement.amountCents <= 0)
        || (expectsNegative && movement.amountCents >= 0)) {
        issue(issues, 'high', 'deposit_movement_invalid_sign', {
          depositMovementId: movementId,
          movementType: movement.type,
          amountCents: movement.amountCents,
        });
      }
    }

    const tenancy = tenancyById.get(asId(movement.tenancyId));
    if (!tenancy) {
      issue(issues, 'high', 'deposit_movement_missing_tenancy', {
        depositMovementId: movementId,
        tenancyId: movement.tenancyId ? String(movement.tenancyId) : null,
      });
    } else {
      const mismatchedFields = ['clientId', 'estateId', 'houseId', 'tenantId']
        .filter((field) => !sameId(movement[field], tenancy[field]));
      if (mismatchedFields.length) {
        issue(issues, 'critical', 'deposit_movement_tenancy_scope_mismatch', {
          depositMovementId: movementId,
          tenancyId: String(tenancy._id),
          mismatchedFields,
        });
      }
    }

    const counterparts = depositLedgersByMovement.get(movementId) || [];
    if (counterparts.length === 0) {
      issue(issues, 'high', 'missing_deposit_movement_ledger', {
        depositMovementId: movementId,
        movementType: movement.type,
        tenancyId: movement.tenancyId ? String(movement.tenancyId) : null,
      });
    } else {
      if (counterparts.length > 1) {
        issue(issues, 'critical', 'duplicate_deposit_movement_ledger', {
          depositMovementId: movementId,
          count: counterparts.length,
          ledgerIds: sampleIds(counterparts),
        });
      }

      for (const ledger of counterparts) {
        const mismatchedFields = [
          'clientId', 'estateId', 'houseId', 'tenantId', 'tenancyId',
        ].filter((field) => !sameId(movement[field], ledger[field]));

        if (mismatchedFields.length
          || ledger.accountCategory !== 'DEPOSIT'
          || ledger.entryType !== expectedEntryType
          || ledger.referenceType !== 'DepositMovement'
          || !sameId(ledger.referenceId, movement._id)) {
          issue(issues, 'critical', 'deposit_movement_ledger_scope_mismatch', {
            depositMovementId: movementId,
            ledgerId: String(ledger._id),
            mismatchedFields,
            expectedEntryType,
            actualEntryType: ledger.entryType,
            actualAccountCategory: ledger.accountCategory,
          });
        }

        if (ledger.amountCents !== movement.amountCents) {
          issue(issues, 'high', 'deposit_movement_ledger_amount_mismatch', {
            depositMovementId: movementId,
            ledgerId: String(ledger._id),
            movementAmountCents: movement.amountCents,
            ledgerAmountCents: ledger.amountCents,
          });
        }
      }
    }

    if (movement.type === 'TRANSFER_OUT') {
      const inboundLegs = depositMovements.filter(
        (candidate) => candidate.type === 'TRANSFER_IN'
          && sameId(candidate.linkedMovementId, movement._id)
      );
      if (inboundLegs.length !== 1) {
        issue(issues, 'high', 'deposit_transfer_outbound_pair_count', {
          depositMovementId: movementId,
          inboundLegCount: inboundLegs.length,
          inboundSampleIds: sampleIds(inboundLegs),
        });
      }
    } else if (movement.type === 'TRANSFER_IN') {
      const outbound = movement.linkedMovementId
        ? depositMovementById.get(asId(movement.linkedMovementId))
        : null;

      if (!outbound) {
        issue(issues, 'high', 'deposit_transfer_inbound_missing_outbound', {
          depositMovementId: movementId,
          linkedMovementId: movement.linkedMovementId
            ? String(movement.linkedMovementId)
            : null,
        });
      } else {
        if (outbound.type !== 'TRANSFER_OUT'
          || !sameId(outbound.clientId, movement.clientId)) {
          issue(issues, 'critical', 'deposit_transfer_pair_scope_mismatch', {
            depositMovementId: movementId,
            outboundMovementId: String(outbound._id),
            outboundType: outbound.type,
          });
        }
        if (movement.amountCents !== -outbound.amountCents) {
          issue(issues, 'high', 'deposit_transfer_amount_mismatch', {
            inboundMovementId: movementId,
            outboundMovementId: String(outbound._id),
            inboundAmountCents: movement.amountCents,
            outboundAmountCents: outbound.amountCents,
          });
        }
      }
    } else if (movement.linkedMovementId) {
      issue(issues, 'high', 'deposit_movement_unexpected_link', {
        depositMovementId: movementId,
        movementType: movement.type,
        linkedMovementId: String(movement.linkedMovementId),
      });
    }
  }

  // A ledger reference without a corresponding movement is an orphan, not
  // evidence that a movement occurred.
  for (const [movementId, rows] of depositLedgersByMovement) {
    if (!depositMovementById.has(movementId)) {
      issue(issues, 'high', 'orphan_deposit_movement_ledger', {
        referenceId: movementId,
        count: rows.length,
        sampleLedgerIds: sampleIds(rows),
      });
    }
  }

  for (const l of ledgers) {
    if (!l.tenancyId) continue;
    const tenancy = tenancyById.get(asId(l.tenancyId));
    if (!tenancy) {
      issue(issues, 'high', 'ledger_missing_tenancy_record', {
        ledgerId: String(l._id), tenancyId: String(l.tenancyId),
      });
    } else if (!sameId(l.clientId, tenancy.clientId)
      || !sameId(l.estateId, tenancy.estateId)
      || !sameId(l.houseId, tenancy.houseId)
      || (l.tenantId != null && !sameId(l.tenantId, tenancy.tenantId))) {
      issue(issues, 'critical', 'ledger_tenancy_scope_mismatch', {
        ledgerId: String(l._id), tenancyId: String(l.tenancyId),
      });
    }
  }
  const ledgerBySource = new Map();
  for (const l of ledgers) {
    if (l.referenceType === 'RentCharge' || l.referenceType === 'Payment') {
      const key = sourceLedgerKey(l.referenceType, l.referenceId, l.entryType);
      const group = ledgerBySource.get(key) || [];
      group.push(l);
      ledgerBySource.set(key, group);
    }
  }

  const checkSourceLedger = (source, referenceType, entryType, expectedAmount, label) => {
    const sourcePayload = label === 'charge'
      ? { rentChargeId: String(source._id) }
      : { paymentId: String(source._id) };
    const rows = ledgerBySource.get(sourceLedgerKey(referenceType, source._id, entryType)) || [];
    if (!rows.length) {
      issue(issues, 'high', `missing_${label}_ledger`, {
        ...sourcePayload, tenancyId: source.tenancyId ? String(source.tenancyId) : null,
      });
      return;
    }
    if (rows.length > 1) {
      issue(issues, 'high', `duplicate_${label}_ledger`, { ...sourcePayload, count: rows.length });
      return;
    }
    const ledger = rows[0];
    if (!sameId(ledger.tenancyId, source.tenancyId)) {
      issue(issues, 'high', `${label}_ledger_tenancy_mismatch`, {
        ...sourcePayload, ledgerId: String(ledger._id),
      });
    }
    if (!ledger.tenancyId) {
      issue(issues, 'high', `${label}_ledger_missing_tenancy`, { ledgerId: String(ledger._id) });
    }
    const nonTenancyFields = ['clientId', 'estateId', 'houseId', 'tenantId'];
    const mismatchedFields = nonTenancyFields.filter((field) => !sameId(source[field], ledger[field]));
    if (mismatchedFields.length || ledger.accountCategory !== 'RENT'
      || ledger.entryType !== entryType || ledger.referenceType !== referenceType
      || !sameId(ledger.referenceId, source._id)) {
      issue(issues, 'high', `${label}_ledger_scope_mismatch`, {
        ...sourcePayload, ledgerId: String(ledger._id), mismatchedFields,
      });
    }
    if (ledger.amountCents !== expectedAmount) {
      issue(issues, 'medium', `${label}_ledger_amount_mismatch`, {
        ...sourcePayload, expected: expectedAmount, actual: ledger.amountCents,
      });
    }
    if (String(ledger.period || '') !== String(source.period || '')) {
      issue(issues, 'medium', `${label}_ledger_period_mismatch`, {
        ...sourcePayload, expected: source.period || null, actual: ledger.period || null,
      });
    }
  };

  for (const c of charges) {
    if (c.tenancyId) checkSourceLedger(c, 'RentCharge', 'CHARGE', -Math.abs(c.amountDueCents), 'charge');
  }
  for (const p of payments) {
    if (p.tenancyId && p.status === 'CONFIRMED') checkSourceLedger(p, 'Payment', 'PAYMENT', p.amountCents, 'payment');
  }

  // A RENT CHARGE/PAYMENT ledger movement without its source is not a valid
  // substitute for the source record. Missing-tenancy legacy movements remain
  // classified separately instead of being attributed to a current occupant.
  const chargeMap = new Map(charges.map((c) => [asId(c._id), c]));
  const paymentMap = new Map(payments.map((p) => [asId(p._id), p]));
  for (const l of ledgers) {
    if (l.accountCategory !== 'RENT' || !['CHARGE', 'PAYMENT'].includes(l.entryType)) continue;
    const expectedType = l.entryType === 'CHARGE' ? 'RentCharge' : 'Payment';
    if (l.referenceType !== expectedType || !l.referenceId) {
      if (!l.tenancyId) continue;
      issue(issues, 'high', 'rent_ledger_missing_exact_source_reference', { ledgerId: String(l._id) });
      continue;
    }
    const source = expectedType === 'RentCharge'
      ? chargeMap.get(asId(l.referenceId))
      : paymentMap.get(asId(l.referenceId));
    if (!source && (!clientId || sameId(l.clientId, clientId))) {
      issue(issues, 'high', 'orphan_rent_ledger_source', {
        ledgerId: String(l._id), referenceType: l.referenceType, referenceId: String(l.referenceId),
      });
    }
  }

  const missingTenancyLedgers = ledgers.filter((l) => l.accountCategory === 'RENT'
    && ['CHARGE', 'PAYMENT'].includes(l.entryType) && !l.tenancyId);
  pushLegacy(legacy, 'legacy_unattributed_ledger', missingTenancyLedgers);

  // Validate unordered signed transitions as a directed Euler trail from zero.
  issues.push(...inspectLedgerBalanceChains(ledgers));

  const critical = issues.filter((i) => i.severity === 'critical').length;
  const high = issues.filter((i) => i.severity === 'high').length;
  return {
    ok: critical === 0 && high === 0,
    summary: {
      critical,
      high,
      medium: issues.filter((i) => i.severity === 'medium').length,
      info: info.length,
      legacy: legacy.length,
      chargesScanned: charges.length,
      paymentsScanned: payments.length,
      allocationsScanned: allocations.length,
      ledgerRowsScanned: ledgers.length,
      tenanciesScanned: tenancies.length,
    },
    issues,
    info,
    legacy,
    generatedAt: new Date().toISOString(),
  };
}
