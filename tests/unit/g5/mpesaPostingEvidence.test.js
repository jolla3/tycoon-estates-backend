import { evaluateEvidence, BUY_GOODS_TYPE, TIMESTAMP_TOLERANCE_MS, postingGate, POSTING_BLOCK } from '../../../src/services/mpesa/mpesaPosting.service.js';

const oid = (c) => c.repeat(24);
const base = () => ({
  link: { status: 'ACTIVE', clientId: oid('a'), estateId: oid('b') },
  profile: { _id: oid('c'), clientId: oid('a'), estateId: oid('b'), operationalState: 'ACTIVE' },
  txn: { merchantProfileId: oid('c'), clientId: oid('a'), transactionType: BUY_GOODS_TYPE, verificationState: 'MATCHED',
    receiptNumber: 'QJK2ABCDEF', amountCents: 1000, acceptedAmountCents: 1000, transactionAt: new Date('2026-10-20T12:15:30Z'), acceptedTransactionAt: new Date('2026-10-20T12:15:30Z'), attributedTenantId: null },
  submission: { tenantId: oid('d'), receiptNumber: 'QJK2ABCDEF', amountCents: 1000, smsTransactionAt: new Date('2026-10-20T12:15:00Z') },
});
const run = (mut) => { const b = base(); mut?.(b); return evaluateEvidence(b); };

describe('evaluateEvidence', () => {
  test('all evidence agrees', () => expect(run().ok).toBe(true));
  test.each([
    ['LINK_NOT_ACTIVE', (b) => { b.link.status = 'REVOKED'; }],
    ['MERCHANT_NOT_OPERATIONAL', (b) => { b.profile.operationalState = 'NOT_READY'; }],
    ['MERCHANT_ESTATE_UNMAPPED', (b) => { b.profile.estateId = null; }],
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
  test('same Tenant re-claim is allowed; payer identity is never an input', () => {
    expect(run((b) => { b.txn.attributedTenantId = b.submission.tenantId; }).ok).toBe(true);
    expect(JSON.stringify(base())).not.toMatch(/msisdn|payer/i);
  });
});

describe('postingGate (fail-closed)', () => {
  test('disabled by default', async () => {
    expect(await postingGate()).toBe(POSTING_BLOCK.DISABLED);
  });
});
