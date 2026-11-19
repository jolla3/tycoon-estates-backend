import { describe, test, expect } from '@jest/globals';
import { MpesaMerchantProfile } from '../../../src/models/MpesaMerchantProfile.js';
import { MpesaMerchantProfileEstate } from '../../../src/models/MpesaMerchantProfileEstate.js';
import { MpesaCollectionReference } from '../../../src/models/MpesaCollectionReference.js';
import {
  MERCHANT_UNIQUE_INDEX, PROFILE_ESTATE_UNIQUE_INDEX, REFERENCE_UNIQUE_INDEXES, indexMatches,
} from '../../../src/utils/mpesaIndexReadiness.js';
import { safeMerchantProfile } from '../../../src/services/platformIntegrations.service.js';
import { getCallbackConfig } from '../../../src/services/mpesa/darajaCallbackConfig.service.js';
import { maskMsisdn, normalizeKenyanMsisdn } from '../../../src/services/mpesa/mpesaRegistration.service.js';
import { evaluateReferenceEvidence, PAYBILL_TYPE } from '../../../src/services/mpesa/mpesaPosting.service.js';

const idx = (M) => M.schema.indexes().map(([key, o]) => ({ key, ...o }));

describe('schema declarations match readiness specs', () => {
  test('all four schemas disable autoIndex', () => {
    for (const M of [MpesaMerchantProfile, MpesaMerchantProfileEstate, MpesaCollectionReference]) {
      expect(M.schema.options.autoIndex).toBe(false);
    }
  });
  test('global shortcode ownership index is {provider, businessShortCode}', () => {
    expect(idx(MpesaMerchantProfile).some((i) => i.name === MERCHANT_UNIQUE_INDEX.name && i.unique
      && JSON.stringify(i.key) === JSON.stringify({ provider: 1, businessShortCode: 1 }))).toBe(true);
  });
  test('mapping and reference unique indexes exist', () => {
    expect(indexMatches(idx(MpesaMerchantProfileEstate).map((i) => ({ ...i, unique: Boolean(i.unique) })), PROFILE_ESTATE_UNIQUE_INDEX)).toBe(true);
    for (const spec of REFERENCE_UNIQUE_INDEXES) {
      expect(indexMatches(idx(MpesaCollectionReference).map((i) => ({ ...i, unique: Boolean(i.unique) })), spec)).toBe(true);
    }
  });
  test('a missing or non-partial active-tenancy index fails the readiness match', () => {
    const wrong = [{ key: { merchantProfileId: 1, tenancyId: 1 }, unique: true, name: 'uniq_mpesa_ref_active_tenancy' }];
    expect(indexMatches(wrong, REFERENCE_UNIQUE_INDEXES[1])).toBe(false);
    expect(indexMatches([], MERCHANT_UNIQUE_INDEX)).toBe(false);
  });
  test('merchant model supports both types', () => {
    expect(MpesaMerchantProfile.schema.path('merchantType').enumValues).toEqual(['PAYBILL', 'BUY_GOODS_TILL']);
  });
});

describe('safeMerchantProfile', () => {
  test('never leaks the nominated number, ciphertext or secrets', () => {
    const dto = safeMerchantProfile({
      _id: 'p1', clientId: 'c1', merchantType: 'PAYBILL', businessShortCode: '123456',
      pullNominatedMsisdnEncrypted: 'iv:tag:cipher', pullNominatedMsisdnMasked: '2547****678',
      c2bRegistration: { configVersion: 'abc', confirmationUrl: 'https://x/y', providerConversationId: 'conv-1' },
    }, undefined, [{ estateId: 'e1', status: 'ACTIVE' }]);
    const json = JSON.stringify(dto);
    expect(json).not.toMatch(/iv:tag:cipher|conv-1|Encrypted/);
    expect(dto.pullNominatedNumber).toEqual({ captured: true, masked: '2547****678' });
    expect(dto.estates).toEqual([{ estateId: 'e1', status: 'ACTIVE' }]);
  });
});

describe('callback config', () => {
  const base = { DARAJA_ENVIRONMENT: 'sandbox', DARAJA_CALLBACK_BASE_URL: 'https://api.example.com' };
  test('not configured without an https base', () => {
    expect(getCallbackConfig({ DARAJA_ENVIRONMENT: 'sandbox' }).configured).toBe(false);
    expect(getCallbackConfig({ ...base, DARAJA_CALLBACK_BASE_URL: 'http://api.example.com' }).configured).toBe(false);
    expect(getCallbackConfig({ ...base, DARAJA_CALLBACK_BASE_URL: 'https://u:p@api.example.com' }).configured).toBe(false);
  });
  test('stable id, deterministic version that changes with the URL set', () => {
    const a = getCallbackConfig(base);
    expect(a).toMatchObject({ configured: true, configId: 'daraja-sandbox' });
    expect(a.confirmationUrl).toBe('https://api.example.com/api/v1/webhooks/daraja/c2b/confirm');
    expect(getCallbackConfig(base).version).toBe(a.version);
    expect(getCallbackConfig({ ...base, DARAJA_CALLBACK_BASE_URL: 'https://other.example.com' }).version).not.toBe(a.version);
  });
});

describe('Pull nominated number protection helpers', () => {
  test('normalizes Kenyan numbers and masks the middle', () => {
    expect(normalizeKenyanMsisdn('0712 345 678')).toBe('254712345678');
    expect(normalizeKenyanMsisdn('+254112345678')).toBe('254112345678');
    expect(normalizeKenyanMsisdn('12345')).toBeNull();
    expect(maskMsisdn('254712345678')).toBe('2547*****678');
  });
});

describe('PayBill reference evidence (typed path)', () => {
  const oid = (c) => c.repeat(24);
  const base = () => ({
    mappingActive: true,
    reference: { _id: oid('r'), status: 'ACTIVE', merchantProfileId: oid('m'), clientId: oid('a'), estateId: oid('b'), tenantId: oid('t'), tenancyId: oid('y') },
    profile: { _id: oid('m'), clientId: oid('a'), merchantType: 'PAYBILL', operationalState: 'ACTIVE' },
    tenancy: { _id: oid('y'), clientId: oid('a'), estateId: oid('b'), tenantId: oid('t'), status: 'ACTIVE' },
    txn: { merchantProfileId: oid('m'), clientId: oid('a'), transactionType: PAYBILL_TYPE, verificationState: 'MATCHED', amountCents: 1000, acceptedAmountCents: 1000, attributedTenantId: null, allocationReferenceId: oid('r') },
  });
  const run = (mut) => { const b = base(); mut?.(b); return evaluateReferenceEvidence(b); };
  test('agreeing evidence passes', () => expect(run().ok).toBe(true));
  test.each([
    ['REFERENCE_NOT_FOUND', (b) => { b.reference = null; }],
    ['REFERENCE_RETIRED', (b) => { b.reference.status = 'RETIRED'; }],
    ['MERCHANT_NOT_OPERATIONAL', (b) => { b.profile.operationalState = 'DRAFT'; }],
    ['NOT_PAYBILL_MERCHANT', (b) => { b.profile.merchantType = 'BUY_GOODS_TILL'; }],
    ['REFERENCE_MERCHANT_MISMATCH', (b) => { b.reference.merchantProfileId = oid('z'); }],
    ['MERCHANT_CLIENT_MISMATCH', (b) => { b.reference.clientId = oid('z'); }],
    ['MERCHANT_ESTATE_UNMAPPED', (b) => { b.mappingActive = false; }],
    ['NOT_PAYBILL', (b) => { b.txn.transactionType = 'CustomerBuyGoodsOnline'; }],
    ['RECEIPT_NOT_VERIFIED', (b) => { b.txn.verificationState = 'UNVERIFIED'; }],
    ['AMOUNT_MISMATCH', (b) => { b.txn.acceptedAmountCents = 1; }],
    ['TENANCY_IDENTITY_MISMATCH', (b) => { b.tenancy.tenantId = oid('z'); }],
    ['TENANCY_NOT_ACTIVE', (b) => { b.tenancy.status = 'CLOSED'; }],
    ['COMPETING_CLAIM', (b) => { b.txn.attributedTenantId = oid('e'); }],
  ])('%s', (reason, mut) => expect(run(mut)).toEqual({ ok: false, reason }));
});
