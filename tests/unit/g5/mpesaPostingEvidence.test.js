import {
  evaluateEvidence,
  evaluateTillTenancyCandidates,
  evaluateReferenceEvidence,
  BUY_GOODS_TYPE,
  PAYBILL_TYPE,
  TIMESTAMP_TOLERANCE_MS,
  postingGate,
  POSTING_BLOCK,
} from '../../../src/services/mpesa/mpesaPosting.service.js';

const oid = (c) => c.repeat(24);
const base = () => ({
  mappingActive: true,
  link: { _id: oid('f'), status: 'ACTIVE', clientId: oid('a'), estateId: oid('b'), tenantId: oid('d') },
  profile: { _id: oid('c'), clientId: oid('a'), merchantType: 'BUY_GOODS_TILL', operationalState: 'ACTIVE' },
  txn: { merchantProfileId: oid('c'), clientId: oid('a'), transactionType: BUY_GOODS_TYPE, verificationState: 'MATCHED',
    receiptNumber: 'QJK2ABCDEF', amountCents: 1000, acceptedAmountCents: 1000, transactionAt: new Date('2026-10-20T12:15:30Z'), acceptedTransactionAt: new Date('2026-10-20T12:15:30Z'), attributedTenantId: null },
  submission: {
    clientId: oid('a'), estateId: oid('b'), tenantId: oid('d'), linkId: oid('f'),
    receiptNumber: 'QJK2ABCDEF', amountCents: 1000,
    smsTransactionAt: new Date('2026-10-20T12:15:00Z'),
  },
});
const run = (mut) => { const b = base(); mut?.(b); return evaluateEvidence(b); };

describe('evaluateEvidence', () => {
  test('all evidence agrees', () => expect(run().ok).toBe(true));
  test.each([
    ['LINK_NOT_ACTIVE', (b) => { b.link.status = 'REVOKED'; }],
    ['MERCHANT_NOT_OPERATIONAL', (b) => { b.profile.operationalState = 'NOT_READY'; }],
    ['MERCHANT_ESTATE_UNMAPPED', (b) => { b.mappingActive = false; }],
    ['NOT_TILL_MERCHANT', (b) => { b.profile.merchantType = 'PAYBILL'; }],
    ['LINK_MERCHANT_MISMATCH', (b) => { b.link.merchantProfileId = oid('z'); }],
    ['MERCHANT_CLIENT_MISMATCH', (b) => { b.profile.clientId = oid('z'); }],
    ['RECEIPT_SCOPE_MISMATCH', (b) => { b.txn.merchantProfileId = oid('z'); }],
    ['NOT_BUY_GOODS', (b) => { b.txn.transactionType = 'Pay Bill'; }],
    ['RECEIPT_NOT_VERIFIED', (b) => { b.txn.verificationState = 'UNVERIFIED'; }],
    ['RECEIPT_NUMBER_MISMATCH', (b) => { b.submission.receiptNumber = 'ZZZZZZZZZZ'; }],
    ['AMOUNT_MISMATCH', (b) => { b.submission.amountCents = 1001; }],
    ['TIMESTAMP_OUT_OF_TOLERANCE', (b) => { b.submission.smsTransactionAt = new Date(b.txn.transactionAt.getTime() + TIMESTAMP_TOLERANCE_MS + 1); }],
    ['AMOUNT_MISMATCH', (b) => { b.txn.acceptedAmountCents = 999; }],
    ['TIMESTAMP_OUT_OF_TOLERANCE', (b) => { b.txn.acceptedTransactionAt = new Date(b.txn.transactionAt.getTime() + TIMESTAMP_TOLERANCE_MS + 1); }],
    ['CURRENCY_MISMATCH', (b) => { b.txn.currency = 'USD'; b.submission.currency = 'KES'; }],
    ['COMPETING_CLAIM', (b) => { b.txn.attributedTenantId = oid('e'); }],
  ])('%s', (reason, mut) => expect(run(mut)).toEqual({ ok: false, reason }));
  test('legacy profile.estateId alone never authorizes an estate', () => {
    expect(run((b) => { b.profile.estateId = b.link.estateId; b.mappingActive = false; }))
      .toEqual({ ok: false, reason: 'MERCHANT_ESTATE_UNMAPPED' });
  });
  test('same Tenant re-claim is allowed; payer identity is never an input', () => {
    expect(run((b) => { b.txn.attributedTenantId = b.submission.tenantId; }).ok).toBe(true);
    expect(JSON.stringify(base())).not.toMatch(/msisdn|payer/i);
  });

  test('accepted submission survives link rotation and revocation using its accepted version proof', () => {
    const b = base();
    b.link.status = 'REVOKED';
    b.link.linkVersion = 3;
    b.submission.acceptedAt = new Date('2026-10-20T12:16:00Z');
    b.submission.acceptedLinkVersion = 2;
    b.submission.linkVersion = 2;
    expect(evaluateEvidence(b)).toEqual({ ok: true, reason: null });
  });

  test.each([
    ['LINK_SCOPE_MISMATCH', (b) => { b.link.tenantId = oid('9'); }],
    ['LINK_SCOPE_MISMATCH', (b) => { b.link.estateId = oid('9'); }],
    ['RECEIPT_SCOPE_MISMATCH', (b) => { b.txn.clientId = oid('9'); }],
  ])('%s', (reason, mutate) => {
    const b = base();
    mutate(b);
    expect(evaluateEvidence(b)).toEqual({ ok: false, reason });
  });
});

describe('postingGate (fail-closed)', () => {
  test('disabled by default', async () => {
    expect(await postingGate()).toBe(POSTING_BLOCK.DISABLED);
  });
});


const sourceScope = () => ({
  clientId: oid('a'),
  estateId: oid('b'),
  tenantId: oid('d'),
  tenancyId: oid('e'),
  houseId: oid('f'),
  eventAt: new Date('2026-10-20T12:15:30.000Z'),
});
const tillTenancy = (overrides = {}) => {
  const scope = sourceScope();
  return {
    _id: scope.tenancyId,
    clientId: scope.clientId,
    estateId: scope.estateId,
    tenantId: scope.tenantId,
    houseId: scope.houseId,
    startAt: new Date('2026-10-20T12:15:30.000Z'),
    endAt: new Date('2026-10-21T00:00:00.000Z'),
    status: 'ACTIVE',
    ...overrides,
  };
};
const tillHouse = (overrides = {}) => {
  const scope = sourceScope();
  return {
    _id: scope.houseId,
    clientId: scope.clientId,
    estateId: scope.estateId,
    ...overrides,
  };
};
const runTillTenancy = ({ txn = {}, candidates, sourceHouse = tillHouse(), tenancyOverrides = {} } = {}) => {
  const scope = sourceScope();
  const rows = candidates || [tillTenancy(tenancyOverrides)];
  return evaluateTillTenancyCandidates({
    txn: { transactionAt: scope.eventAt, attributedTenancyId: null, ...txn },
    clientId: scope.clientId,
    estateId: scope.estateId,
    tenantId: scope.tenantId,
    candidates: rows,
    sourceHouse,
  });
};

describe('Till source-tenancy attribution', () => {
  test('startAt is inclusive and a unique ACTIVE source House is returned', () => {
    const result = runTillTenancy();
    expect(result.ok).toBe(true);
    expect(result.tenancy._id).toBe(sourceScope().tenancyId);
    expect(result.house._id).toBe(sourceScope().houseId);
  });

  test('endAt is exclusive', () => {
    const scope = sourceScope();
    expect(runTillTenancy({
      txn: { transactionAt: new Date('2026-10-21T00:00:00.000Z') },
    })).toEqual({ ok: false, reason: 'NO_TENANCY_COVERS_TRANSACTION_AT' });
    expect(runTillTenancy({
      txn: { transactionAt: scope.eventAt },
      tenancyOverrides: { endAt: scope.eventAt },
    }).reason).toBe('NO_TENANCY_COVERS_TRANSACTION_AT');
  });

  test('null endAt has no upper bound', () => {
    const result = runTillTenancy({
      txn: { transactionAt: new Date('2030-01-01T00:00:00.000Z') },
      tenancyOverrides: { endAt: null },
    });
    expect(result.ok).toBe(true);
  });

  test('zero candidates require review', () => {
    expect(runTillTenancy({ candidates: [] }))
      .toEqual({ ok: false, reason: 'NO_TENANCY_COVERS_TRANSACTION_AT' });
  });

  test('multiple overlapping candidates are ambiguous, even for the same tenant', () => {
    const first = tillTenancy();
    const second = tillTenancy({ _id: oid('9'), houseId: oid('8'), startAt: new Date('2026-10-20T11:00:00.000Z') });
    expect(runTillTenancy({ candidates: [first, second] }))
      .toEqual({ ok: false, reason: 'AMBIGUOUS_TENANCY_COVERAGE' });
  });

  test('CLOSED historical coverage is recognized but remains review-only', () => {
    expect(runTillTenancy({ tenancyOverrides: { status: 'CLOSED' } }))
      .toEqual({ ok: false, reason: 'TENANCY_NOT_ACTIVE' });
  });

  test('VOID tenancy is never a candidate', () => {
    expect(runTillTenancy({ tenancyOverrides: { status: 'VOID' } }))
      .toEqual({ ok: false, reason: 'NO_TENANCY_COVERS_TRANSACTION_AT' });
  });

  test('invalid provider timestamp fails closed', () => {
    expect(runTillTenancy({ txn: { transactionAt: 'not-a-date' } }))
      .toEqual({ ok: false, reason: 'INVALID_TRANSACTION_TIMESTAMP' });
  });

  test('client, estate and tenant identity must match exactly', () => {
    expect(runTillTenancy({
      tenancyOverrides: { estateId: oid('9') },
    })).toEqual({ ok: false, reason: 'TENANCY_SCOPE_MISMATCH' });
  });

  test('source House must match the resolved tenancy and exact estate/client', () => {
    expect(runTillTenancy({ sourceHouse: null }))
      .toEqual({ ok: false, reason: 'SOURCE_HOUSE_IDENTITY_MISMATCH' });
    expect(runTillTenancy({
      sourceHouse: tillHouse({ _id: oid('9') }),
    })).toEqual({ ok: false, reason: 'SOURCE_HOUSE_IDENTITY_MISMATCH' });
  });

  test('a different previously attributed source tenancy is a competing claim', () => {
    expect(runTillTenancy({ txn: { attributedTenancyId: oid('9') } }))
      .toEqual({ ok: false, reason: 'COMPETING_CLAIM' });
  });
});

const paybillEvidence = (mutate) => {
  const scope = sourceScope();
  const reference = {
    _id: oid('1'),
    clientId: scope.clientId,
    estateId: scope.estateId,
    tenantId: scope.tenantId,
    tenancyId: scope.tenancyId,
    merchantProfileId: oid('2'),
    status: 'ACTIVE',
  };
  const profile = {
    _id: oid('2'),
    clientId: scope.clientId,
    merchantType: 'PAYBILL',
    operationalState: 'ACTIVE',
  };
  const tenancy = tillTenancy();
  const sourceHouse = tillHouse();
  const txn = {
    _id: oid('3'),
    clientId: scope.clientId,
    merchantProfileId: profile._id,
    transactionType: PAYBILL_TYPE,
    verificationState: 'MATCHED',
    amountCents: 1000,
    acceptedAmountCents: 1000,
    transactionAt: scope.eventAt,
    allocationState: 'ALLOCATED_BY_REFERENCE',
    allocationReferenceId: reference._id,
    allocatedEstateId: reference.estateId,
    allocatedTenantId: reference.tenantId,
    allocatedTenancyId: reference.tenancyId,
    attributedTenantId: null,
    attributedTenancyId: null,
  };
  const data = { txn, reference, profile, mappingActive: true, tenancy, sourceHouse };
  mutate?.(data);
  return evaluateReferenceEvidence(data);
};

describe('PayBill source-tenancy attribution', () => {
  test('valid reference posts only against its exact timestamp-covering tenancy and House', () => {
    expect(paybillEvidence()).toEqual({ ok: true, reason: null });
  });

  test('startAt is inclusive and endAt is exclusive', () => {
    expect(paybillEvidence((b) => {
      b.tenancy.startAt = b.txn.transactionAt;
    })).toEqual({ ok: true, reason: null });
    expect(paybillEvidence((b) => {
      b.tenancy.endAt = b.txn.transactionAt;
    })).toEqual({ ok: false, reason: 'TENANCY_TRANSACTION_TIME_MISMATCH' });
  });

  test('closed historical tenancy is review-only even when timestamp is inside its interval', () => {
    expect(paybillEvidence((b) => {
      b.tenancy.status = 'CLOSED';
    })).toEqual({ ok: false, reason: 'TENANCY_NOT_ACTIVE' });
  });

  test('retired reference remains review-only and is not reassigned', () => {
    expect(paybillEvidence((b) => {
      b.reference.status = 'RETIRED';
    })).toEqual({ ok: false, reason: 'REFERENCE_RETIRED' });
  });

  test('all persisted reference allocation fields must match the immutable reference', () => {
    expect(paybillEvidence((b) => {
      b.txn.allocatedTenancyId = oid('9');
    })).toEqual({ ok: false, reason: 'REFERENCE_ALLOCATION_MISMATCH' });
    expect(paybillEvidence((b) => {
      b.txn.allocationState = 'UNALLOCATED';
    })).toEqual({ ok: false, reason: 'REFERENCE_ALLOCATION_MISMATCH' });
  });

  test('source House must be the reference tenancy House in the same client and estate', () => {
    expect(paybillEvidence((b) => {
      b.sourceHouse._id = oid('9');
    })).toEqual({ ok: false, reason: 'SOURCE_HOUSE_IDENTITY_MISMATCH' });
  });

  test('another previously attributed source tenancy is a competing claim', () => {
    expect(paybillEvidence((b) => {
      b.txn.attributedTenancyId = oid('9');
    })).toEqual({ ok: false, reason: 'COMPETING_CLAIM' });
  });

  test('a previously POSTED receipt can replay read-only after source tenancy closes and reference retires', () => {
    expect(paybillEvidence((b) => {
      b.txn.postingState = 'POSTED';
      b.txn.attributedClientId = b.reference.clientId;
      b.txn.attributedEstateId = b.reference.estateId;
      b.txn.attributedTenancyId = b.reference.tenancyId;
      b.txn.attributedTenantId = b.reference.tenantId;
      b.tenancy.status = 'CLOSED';
      b.reference.status = 'RETIRED';
      b.profile.operationalState = 'INACTIVE';
      b.mappingActive = false;
    })).toEqual({ ok: true, reason: null });
  });

  test('legacy POSTED PayBill without persisted source tenancy is not silently backfilled', () => {
    expect(paybillEvidence((b) => {
      b.txn.postingState = 'POSTED';
      b.txn.attributedTenancyId = null;
      b.reference.status = 'RETIRED';
    })).toEqual({ ok: false, reason: 'POSTED_SOURCE_TENANCY_UNVERIFIED' });
  });
});
