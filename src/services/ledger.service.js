// Ledger — sole financial authority (aggregate of signed movements).
import { Ledger } from '../models/Ledger.js';
import { Tenancy } from '../models/Tenancy.js';

/** Expected sign by (accountCategory, entryType). null = no enforcement (rare). */
const SIGN_RULES = {
  RENT: {
    CHARGE: 'neg',
    PENALTY: 'neg',
    PAYMENT: 'pos',
    SETTLEMENT: 'pos',
    MANUAL_ADJUSTMENT: null,
    BONUS: 'pos',
    LOAN: null,
    INTEREST: 'neg',
    REVERSAL: null,
  },
  DEPOSIT: {
    DEPOSIT_RECEIVED: 'pos',
    DEPOSIT_TRANSFER_IN: 'pos',
    DEPOSIT_DEDUCTION: 'neg',
    DEPOSIT_REFUND: 'neg',
    DEPOSIT_TRANSFER_OUT: 'neg',
    MANUAL_ADJUSTMENT: null,
    REVERSAL: null,
  },
};

function assertSign(accountCategory, entryType, amount) {
  const rules = SIGN_RULES[accountCategory];
  if (!rules) throw new Error(`Unknown accountCategory: ${accountCategory}`);
  if (!(entryType in rules) && rules[entryType] === undefined) {
    // entry type not listed for category — allow only if global enum has it and rule missing
    const rule = rules[entryType];
    if (rule === undefined) {
      // e.g. CHARGE under DEPOSIT — reject
      throw new Error(`entryType ${entryType} not valid for ${accountCategory}`);
    }
  }
  const rule = rules[entryType];
  if (rule === 'pos' && amount <= 0) {
    throw new Error(`${accountCategory}/${entryType} requires positive amountCents`);
  }
  if (rule === 'neg' && amount >= 0) {
    throw new Error(`${accountCategory}/${entryType} requires negative amountCents`);
  }
}

async function sumLedger(clientId, tenancyId, accountCategory, { session } = {}) {
  if (!tenancyId) return 0;
  const rows = await Ledger.aggregate([
    { $match: { clientId, tenancyId, accountCategory } },
    { $group: { _id: null, total: { $sum: '$amountCents' } } },
  ]).session(session || null);
  return rows[0]?.total || 0;
}

async function currentBalanceForTenancy(clientId, tenancyId, accountCategory = 'RENT', { session } = {}) {
  return sumLedger(clientId, tenancyId, accountCategory, { session });
}

async function currentBalanceForHouse(clientId, houseId, { session } = {}) {
  const rows = await Ledger.aggregate([
    { $match: { clientId, houseId, accountCategory: 'RENT' } },
    { $group: { _id: null, total: { $sum: '$amountCents' } } },
  ]).session(session || null);
  return rows[0]?.total || 0;
}

async function postEntry(payload, { session } = {}) {
  const {
    clientId, estateId, houseId, tenantId = null, tenancyId = null,
    accountCategory = 'RENT', entryType, amountCents,
    referenceType = null, referenceId = null, description = '', period = null,
  } = payload;

  if (!Number.isSafeInteger(amountCents) || amountCents === 0) {
    throw new Error('ledger amountCents must be a non-zero safe integer');
  }
  assertSign(accountCategory, entryType, amountCents);

  const requiresTenancy = accountCategory === 'RENT'
    && (entryType === 'CHARGE' || entryType === 'PAYMENT');
  if (requiresTenancy && !tenancyId) {
    throw new Error('tenancyId is required for RENT CHARGE and PAYMENT ledger entries');
  }
  if (requiresTenancy && !session) {
    throw new Error('RENT CHARGE and PAYMENT Ledger entries require a MongoDB transaction');
  }
  if (requiresTenancy && (!referenceType || !referenceId)) {
    throw new Error('RENT CHARGE and PAYMENT Ledger entries require an exact source reference');
  }

  const sameId = (a, b) => (a == null && b == null)
    || (a != null && b != null && String(a) === String(b));
  const matchesExpected = (existing) => Boolean(existing)
    && existing.amountCents === amountCents
    && existing.accountCategory === accountCategory
    && existing.entryType === entryType
    && sameId(existing.clientId, clientId)
    && sameId(existing.estateId, estateId)
    && sameId(existing.houseId, houseId)
    && sameId(existing.tenantId, tenantId)
    && sameId(existing.tenancyId, tenancyId)
    && existing.referenceType === (referenceType || null)
    && sameId(existing.referenceId, referenceId)
    && String(existing.period || '') === String(period || '');

  // Exact source-reference lookup first. A retry may reuse only a movement that
  // matches the full accounting scope, not merely amount + tenancy.
  if (referenceType && referenceId) {
    const existing = await Ledger.findOne({ clientId, referenceType, referenceId, entryType })
      .session(session || null)
      .lean();
    if (existing) {
      if (!matchesExpected(existing)) {
        throw new Error('ledger idempotency conflict: existing movement identity differs');
      }
      return { entry: existing, reused: true };
    }
  }

  // Serialize new tenancy-owned rent movements on one shared document before
  // reading the prior balance. This prevents two different payments/charges
  // for one tenancy from committing the same runningBalanceCents snapshot.
  if (accountCategory === 'RENT' && tenancyId) {
    if (!session) {
      throw new Error('Tenancy-scoped RENT Ledger movements require a MongoDB transaction');
    }
    const lock = await Tenancy.updateOne(
      { _id: tenancyId, clientId, estateId, houseId, ...(tenantId ? { tenantId } : {}) },
      { $inc: { ledgerRev: 1 } },
      { session }
    );
    if (lock.matchedCount !== 1) {
      throw new Error('Ledger tenancy scope does not match an existing Tenancy');
    }
  }

  const prior = tenancyId
    ? await sumLedger(clientId, tenancyId, accountCategory, { session })
    : await currentBalanceForHouse(clientId, houseId, { session });

  const [entry] = await Ledger.create([{
    clientId,
    estateId,
    houseId,
    tenantId: tenantId || null,
    tenancyId: tenancyId || null,
    accountCategory,
    entryType,
    amountCents,
    runningBalanceCents: prior + amountCents,
    referenceType: referenceType || null,
    referenceId: referenceId || null,
    description: description || '',
    period: period || null,
  }], session ? { session } : undefined);
  return { entry, reused: false };
}

async function balanceForTenancy(clientId, tenancyId, accountCategory = 'RENT') {
  if (!tenancyId) {
    return {
      knownLedgerSumCents: null,
      knownArrearsCents: accountCategory === 'RENT' ? null : undefined,
      historicalCoverage: 'UNVERIFIED',
      verifiedFullObligation: false,
      source: 'no_tenancy',
    };
  }

  const sum = await sumLedger(clientId, tenancyId, accountCategory);
  if (accountCategory === 'RENT') {
    return {
      knownLedgerSumCents: sum,
      knownArrearsCents: Math.max(0, -sum),
      knownCreditCents: Math.max(0, sum),
      historicalCoverage: 'UNVERIFIED',
      verifiedFullObligation: false,
      unresolvedHistorical: true,
      source: 'ledger_tenancy_sum',
    };
  }

  return {
    knownLedgerSumCents: sum,
    depositHeldCents: sum,
    depositIntegrityOk: sum >= 0,
    historicalCoverage: 'UNVERIFIED',
    verifiedFullObligation: false,
    unresolvedHistorical: true,
    source: 'ledger_tenancy_sum',
  };
}

async function balanceForHouse(clientId, houseId) {
  // Do not net one tenancy's credit against another tenancy's arrears.
  // Unattributed legacy movements remain outside this provisional projection.
  const rows = await Ledger.aggregate([
    {
      $match: {
        clientId,
        houseId,
        accountCategory: 'RENT',
        tenancyId: { $type: 'objectId' },
      },
    },
    { $group: { _id: '$tenancyId', balanceCents: { $sum: '$amountCents' } } },
  ]);

  const knownLedgerSumCents = rows.reduce((sum, row) => sum + row.balanceCents, 0);
  const knownArrearsCents = rows.reduce(
    (sum, row) => sum + Math.max(0, -row.balanceCents), 0
  );
  const knownCreditCents = rows.reduce(
    (sum, row) => sum + Math.max(0, row.balanceCents), 0
  );

  return {
    knownLedgerSumCents,
    knownArrearsCents,
    knownCreditCents,
    historicalCoverage: 'UNVERIFIED',
    verifiedFullObligation: false,
    unresolvedHistorical: true,
    source: 'ledger_tenancy_aggregate',
  };
}

async function balanceForTenant(clientId, tenantId, houseId) {
  if (houseId) return balanceForHouse(clientId, houseId);
  return {
    knownLedgerSumCents: null,
    knownArrearsCents: null,
    historicalCoverage: 'UNVERIFIED',
    verifiedFullObligation: false,
    source: 'tenant_without_tenancy_scope',
  };
}

async function historyForHouse(clientId, houseId, { limit = 100 } = {}) {
  return Ledger.find({ clientId, houseId }).sort({ createdAt: -1, _id: -1 }).limit(limit).lean();
}
async function historyForTenancy(clientId, tenancyId, { limit = 100 } = {}) {
  return Ledger.find({ clientId, tenancyId }).sort({ createdAt: -1, _id: -1 }).limit(limit).lean();
}
async function totalPaymentsReceived(clientId, { houseId, tenantId, tenancyId } = {}) {
  const match = { clientId, entryType: 'PAYMENT', accountCategory: 'RENT' };
  if (tenancyId) match.tenancyId = tenancyId;
  else if (houseId) match.houseId = houseId;
  else if (tenantId) match.tenantId = tenantId;
  const rows = await Ledger.aggregate([
    { $match: match },
    { $group: { _id: null, total: { $sum: '$amountCents' } } },
  ]);
  return Math.max(0, rows[0]?.total || 0);
}

export const ledgerService = {
  postEntry,
  sumLedger,
  currentBalanceForTenancy,
  currentBalanceForHouse,
  balanceForTenancy,
  balanceForHouse,
  balanceForTenant,
  historyForHouse,
  historyForTenancy,
  totalPaymentsReceived,
};
