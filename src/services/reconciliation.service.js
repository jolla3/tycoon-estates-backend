// src/services/reconciliation.service.js
//
// Bank-agnostic (section 12/19). Only ever consumes the normalized
// BankTransaction shape — has no idea which bank produced it. Never
// guesses: anything it can't confidently match stays UNMATCHED for
// manual admin review (transaction.service.js exposes that path).
//
// clientId flows through from the BankTransaction itself (which the
// webhook/sync path already set from BankAccount.clientId) — this
// service never re-derives or trusts a clientId from anywhere else,
// which is what makes cross-client house matching structurally
// impossible: findHouseByReference always filters by the transaction's
// own clientId.
//
// FINANCIAL ATOMICITY: applyPayment() writes Payment + RentCharge +
// BankTransaction (matchStatus) together inside a MongoDB session
// transaction — a crash between the Payment write and the RentCharge
// write can no longer leave a payment recorded against a stale balance.
// This requires a replica-set (or sharded) MongoDB deployment; a
// standalone mongod does not support multi-document transactions. See
// README "Database Requirements".

import mongoose from 'mongoose';
import { House } from '../models/House.js';
import { Tenant } from '../models/Tenant.js';
import { Payment } from '../models/Payment.js';
import { PaymentAllocation } from '../models/PaymentAllocation.js';
import { rentService } from './rent.service.js';
import { ledgerService } from './ledger.service.js';
import { smsService } from './sms.service.js';
import { dateUtil } from '../utils/date.js';
import { money } from '../utils/money.js';
import { planAllocation, statusAfterPayment } from '../utils/allocation.js';
import { escapeRegex } from '../utils/regex.js';
import { logger } from '../config/logger.js';
import { audit } from './audit.service.js';

/**
 * Matching hierarchy — exact matches only, in this order, never a fuzzy
 * guess:
 *   1. Reference matches House.houseNumber exactly (case-insensitive).
 *   2. Reference matches one of House.paymentReferences (admin-configured
 *      aliases — e.g. a tenant account number that differs from the
 *      house number).
 *   3. UNMATCHED — left for manual admin review.
 *
 * Both steps are scoped to the transaction's clientId — a reference that
 * happens to also match some OTHER client's house number can never be
 * matched to it. Read-only, so it runs outside any transaction.
 */
async function findHouseByReference(clientId, reference) {
  if (!reference) return null;
  const pattern = new RegExp(`^${escapeRegex(reference)}$`, 'i');

  const byHouseNumber = await House.findOne({ clientId, houseNumber: pattern, isActive: true });
  if (byHouseNumber) return byHouseNumber;

  return House.findOne({ clientId, paymentReferences: pattern, isActive: true });
}

export const reconciliationService = {
  async reconcile(bankTransaction) {
    // Already matched → no second Payment / allocation / Ledger effect
    if (bankTransaction.matchStatus === 'MATCHED') {
      const existingPayment = await Payment.findOne({
        bankTransactionId: bankTransaction._id,
        status: 'CONFIRMED',
      }).lean();
      const allocations = existingPayment
        ? await PaymentAllocation.find({ paymentId: existingPayment._id }).lean()
        : [];
      return {
        matched: true,
        reused: true,
        bankTransaction,
        payment: existingPayment || null,
        allocations,
      };
    }

    const reference = (bankTransaction.paymentReference || bankTransaction.narration || '').trim();
    const clientId = bankTransaction.clientId;

    const house = await findHouseByReference(clientId, reference);

    if (!house) {
      bankTransaction.matchStatus = 'UNMATCHED';
      await bankTransaction.save();
      logger.warn({ clientId: String(clientId), reference, transactionId: bankTransaction.providerTransactionId }, 'Bank transaction could not be matched to a house');
      return { matched: false, bankTransaction };
    }

    const tenant = house.tenantId ? await Tenant.findById(house.tenantId) : null;
    const period = dateUtil.periodOf(bankTransaction.transactionDate);

    const session = await mongoose.startSession();
    let payment, allocations, remainingBalanceCents;
    try {
      await session.withTransaction(async () => {
        // Ensure current-period charges exist, then allocate across ALL
        // outstanding charges (older periods first) for cumulative arrears.
        await rentService.ensureChargesForHouse(clientId, house, tenant, period, { session });
        const outstanding = await rentService.outstandingChargesForHouse(clientId, house._id, { session });
        const result = await this.applyPayment({
          bankTransaction,
          house,
          tenant,
          charges: outstanding,
          period,
          session,
        });
        payment = result.payment;
        allocations = result.allocations;
        remainingBalanceCents = result.remainingBalanceCents;

        bankTransaction.matchedHouseId = house._id;
        bankTransaction.matchedTenantId = tenant?._id || null;
        bankTransaction.matchStatus = 'MATCHED';
        await bankTransaction.save({ session });
      });
    } finally {
      await session.endSession();
    }

    // Deliberately OUTSIDE the financial transaction and only reached if
    // it committed successfully.
    await audit({
      clientId: bankTransaction.clientId,
      estateId: house.estateId,
      action: 'PAYMENT_RECONCILED',
      resource: 'Payment',
      resourceId: payment?._id,
      metadata: {
        bankTransactionId: String(bankTransaction._id),
        houseId: String(house._id),
        amountCents: bankTransaction.amountCents,
        allocations: (allocations || []).length,
      },
    });
    for (const a of allocations || []) {
      await audit({
        clientId: bankTransaction.clientId,
        estateId: house.estateId,
        action: 'PAYMENT_ALLOCATED',
        resource: 'PaymentAllocation',
        resourceId: a.rentChargeId,
        metadata: {
          paymentId: String(payment?._id),
          amountCents: a.amountCents,
          chargeType: a.chargeType,
          period: a.period,
        },
      });
    }

    if (tenant?.phone) {
      await smsService.sendPaymentConfirmation({
        clientId: bankTransaction.clientId,
        estateId: house.estateId,
        tenantId: tenant._id,
        houseId: house._id,
        phone: tenant.phone,
        tenantName: tenant.name,
        houseNumber: house.houseNumber,
        amountCents: bankTransaction.amountCents,
        balanceCents: Math.max(remainingBalanceCents ?? 0, 0),
      });
    }

    return { matched: true, house, payment, allocations };
  },

  /**
   * Creates the Payment and updates the RentCharge atomically (same
   * session/transaction as the caller). Shared by both the automatic
   * reconcile() path and the manual "assign UNMATCHED transaction" admin
   * path (transaction.service.js#assignToHouse) — both open their own
   * session and pass it through here, and both are responsible for
   * sending any post-commit notification themselves (see the comment in
   * reconcile() above for why that must stay outside the transaction).
   */
  /**
   * Atomic payment + multi-charge allocation (oldest outstanding first).
   * Accepts either `charges` (preferred) or a single `rentCharge` (legacy).
   */
  async applyPayment({ bankTransaction, house, tenant, charges, rentCharge, period, session }) {
    // Explicit idempotency: same bankTransactionId must never create a second Payment/Ledger
    const existingPayment = await Payment.findOne({
      bankTransactionId: bankTransaction._id,
      status: 'CONFIRMED',
    })
      .session(session || null)
      .lean();
    if (existingPayment) {
      const allocations = await PaymentAllocation.find({ paymentId: existingPayment._id })
        .session(session || null)
        .lean();
      const bal = await ledgerService.balanceForHouse(
        bankTransaction.clientId,
        house._id
      );
      return {
        payment: existingPayment,
        allocations,
        remainingBalanceCents: Math.max(bal.balanceCents, 0),
        reused: true,
      };
    }

    let chargeList = charges;
    if (!chargeList?.length && rentCharge) chargeList = [rentCharge];
    if (!chargeList?.length) {
      chargeList = await rentService.ensureChargesForHouse(
        bankTransaction.clientId,
        house,
        tenant,
        period || dateUtil.periodOf(bankTransaction.transactionDate),
        { session }
      );
    }

    // Include any older outstanding not already in the list
    const older = await rentService.outstandingChargesForHouse(
      bankTransaction.clientId,
      house._id,
      { session }
    );
    const byId = new Map();
    for (const c of [...older, ...chargeList]) byId.set(String(c._id), c);
    chargeList = [...byId.values()];

    const plan = planAllocation(chargeList, bankTransaction.amountCents);
    const primaryPeriod =
      plan[0]?.charge.period || period || dateUtil.periodOf(bankTransaction.transactionDate);

    let payment;
    try {
      const created = await Payment.create(
        [
          {
            clientId: bankTransaction.clientId,
            estateId: house.estateId,
            houseId: house._id,
            tenantId: tenant?._id,
            bankTransactionId: bankTransaction._id,
            amountCents: bankTransaction.amountCents,
            paymentDate: bankTransaction.transactionDate,
            paymentReference: bankTransaction.paymentReference,
            period: primaryPeriod,
          },
        ],
        { session }
      );
      payment = created[0];
    } catch (err) {
      // Unique bankTransactionId race — return existing, do not allocate again
      if (err?.code === 11000) {
        const again = await Payment.findOne({ bankTransactionId: bankTransaction._id })
          .session(session || null)
          .lean();
        if (again) {
          const allocations = await PaymentAllocation.find({ paymentId: again._id })
            .session(session || null)
            .lean();
          const bal = await ledgerService.balanceForHouse(
            bankTransaction.clientId,
            house._id
          );
          return {
            payment: again,
            allocations,
            remainingBalanceCents: Math.max(bal.balanceCents, 0),
            reused: true,
          };
        }
      }
      throw err;
    }

    const allocationDocs = [];
    for (const slice of plan) {
      const charge = slice.charge;
      // Operational cache only — not authoritative account balance
      charge.amountPaidCents = money.add(charge.amountPaidCents || 0, slice.amountCents);
      charge.balanceCents = money.subtract(charge.amountDueCents, charge.amountPaidCents);
      charge.status = statusAfterPayment(charge.amountDueCents, charge.amountPaidCents);
      await charge.save({ session });

      allocationDocs.push({
        clientId: bankTransaction.clientId,
        estateId: house.estateId,
        paymentId: payment._id,
        rentChargeId: charge._id,
        amountCents: slice.amountCents,
        chargeType: charge.chargeType || 'RENT',
        period: charge.period,
      });
    }

    if (allocationDocs.length) {
      await PaymentAllocation.create(allocationDocs, { session });
    }

    // Authoritative financial movement (idempotent on Payment reference)
    await ledgerService.postEntry(
      {
        clientId: bankTransaction.clientId,
        estateId: house.estateId,
        houseId: house._id,
        tenantId: tenant?._id || null,
        entryType: 'PAYMENT',
        amountCents: bankTransaction.amountCents,
        referenceType: 'Payment',
        referenceId: payment._id,
        description: bankTransaction.paymentReference
          ? `Bank payment ${bankTransaction.paymentReference}`
          : 'Bank payment',
        period: primaryPeriod,
      },
      { session }
    );

    const bal = await ledgerService.currentBalanceForHouse(
      bankTransaction.clientId,
      house._id,
      { session }
    );
    const remainingBalanceCents = Math.max(bal, 0);

    return { payment, allocations: allocationDocs, remainingBalanceCents, reused: false };
  },
};
