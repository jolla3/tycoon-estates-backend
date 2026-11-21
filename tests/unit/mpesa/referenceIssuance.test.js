// Logic-level tests with mocked persistence. These do NOT verify MongoDB transactions or the real
// unique indexes; that proof is tests/integration/g54.sharedPaybill.test.js (NOT EXECUTED here).
import '../../setup.js';
import { jest } from '@jest/globals';
import mongoose from 'mongoose';

const inspect = jest.fn();
const create = jest.fn();
const refFindOne = jest.fn();
const profileFindOne = jest.fn();
const tenancyFindOne = jest.fn();
const isActiveMapping = jest.fn();
const audit = jest.fn();

const chain = (v) => ({ session: () => Promise.resolve(v), then: (r) => Promise.resolve(v).then(r) });

jest.unstable_mockModule('../../../src/utils/mpesaIndexReadiness.js', () => ({ inspectMpesaIndexes: inspect }));
jest.unstable_mockModule('../../../src/models/MpesaCollectionReference.js', () => ({
  MpesaCollectionReference: { create, findOne: refFindOne, exists: jest.fn() },
}));
jest.unstable_mockModule('../../../src/models/MpesaMerchantProfile.js', () => ({ MpesaMerchantProfile: { findOne: profileFindOne } }));
jest.unstable_mockModule('../../../src/models/Tenancy.js', () => ({ Tenancy: { findOne: tenancyFindOne } }));
jest.unstable_mockModule('../../../src/models/MpesaTransaction.js', () => ({ MpesaTransaction: {} }));
jest.unstable_mockModule('../../../src/services/audit.service.js', () => ({ auditRequired: audit }));
jest.unstable_mockModule('../../../src/services/mpesa/mpesaMerchantMapping.service.js', () => ({ isActiveMapping }));

const { mpesaReferenceService, duplicateKeyIndex, assertReferenceIndexesReady } = await import('../../../src/services/mpesa/mpesaReference.service.js');

const dup = (index) => Object.assign(new Error(`E11000 duplicate key error index: ${index} dup key`), { code: 11000 });
const args = { clientId: 'c1', merchantProfileId: 'p1', tenancyId: 't1', actor: { _id: 'u1' } };

beforeEach(() => {
  [inspect, create, refFindOne, profileFindOne, tenancyFindOne, isActiveMapping, audit].forEach((m) => m.mockReset());
  jest.spyOn(mongoose, 'startSession').mockResolvedValue({
    withTransaction: async (fn) => fn(), endSession: jest.fn().mockResolvedValue(undefined),
  });
  inspect.mockResolvedValue({ gates: { collectionReferences: true } });
  profileFindOne.mockReturnValue(chain({ _id: 'p1', clientId: 'c1', merchantType: 'PAYBILL' }));
  tenancyFindOne.mockReturnValue(chain({ _id: 't1', status: 'ACTIVE', estateId: 'e1', tenantId: 'n1' }));
  isActiveMapping.mockResolvedValue(true);
  audit.mockResolvedValue(undefined);
});

describe('collection reference issuance fails closed without unique indexes', () => {
  test('missing indexes => 503 and nothing is written or even queried', async () => {
    inspect.mockResolvedValue({ gates: { collectionReferences: false } });
    await expect(mpesaReferenceService.issue(args)).rejects.toMatchObject({ code: 'MPESA_REFERENCE_INDEXES_NOT_READY', status: 503 });
    expect(create).not.toHaveBeenCalled();
    expect(profileFindOne).not.toHaveBeenCalled();
    await expect(assertReferenceIndexesReady()).rejects.toMatchObject({ status: 503 });
  });

  test('no readiness report at all fails closed', async () => {
    inspect.mockResolvedValue(undefined);
    await expect(mpesaReferenceService.issue(args)).rejects.toMatchObject({ status: 503 });
  });
});

describe('issuance race handling relies on unique-index errors, not pre-checks', () => {
  test('success inserts once and audits in the same transaction', async () => {
    create.mockResolvedValue([{ _id: 'r1', reference: 'TXXXXXXXXX' }]);
    const out = await mpesaReferenceService.issue(args);
    expect(out).toMatchObject({ created: true });
    expect(create).toHaveBeenCalledTimes(1);
    expect(audit).toHaveBeenCalledTimes(1);
  });

  test('losing the active-tenancy race returns the winner and issues no second reference', async () => {
    create.mockRejectedValue(dup('uniq_mpesa_ref_active_tenancy'));
    refFindOne.mockResolvedValue({ _id: 'winner', status: 'ACTIVE' });
    const out = await mpesaReferenceService.issue(args);
    expect(out).toEqual({ reference: { _id: 'winner', status: 'ACTIVE' }, created: false });
    expect(create).toHaveBeenCalledTimes(1);
    expect(audit).not.toHaveBeenCalled();
  });

  test('a candidate collision draws a new candidate (new transaction), bounded', async () => {
    create.mockRejectedValueOnce(dup('uniq_mpesa_ref_merchant_reference'))
      .mockResolvedValueOnce([{ _id: 'r2', reference: 'TYYYYYYYYY' }]);
    const out = await mpesaReferenceService.issue(args);
    expect(out.created).toBe(true);
    expect(create).toHaveBeenCalledTimes(2);
    const refs = create.mock.calls.map((c) => c[0][0].reference);
    expect(refs[0]).not.toBe(refs[1]);
  });

  test('persistent collisions give up with a conflict instead of looping', async () => {
    create.mockRejectedValue(dup('uniq_mpesa_ref_merchant_reference'));
    await expect(mpesaReferenceService.issue(args)).rejects.toMatchObject({ status: 409 });
    expect(create).toHaveBeenCalledTimes(6);
  });

  test('active-tenancy duplicate with no visible winner is a retryable conflict, never a second issue', async () => {
    create.mockRejectedValue(dup('uniq_mpesa_ref_active_tenancy'));
    refFindOne.mockResolvedValue(null);
    await expect(mpesaReferenceService.issue(args)).rejects.toMatchObject({ status: 409 });
    expect(create).toHaveBeenCalledTimes(1);
  });

  test('unrelated errors propagate; non-ACTIVE tenancy and inactive mapping are rejected before any insert', async () => {
    tenancyFindOne.mockReturnValue(chain({ _id: 't1', status: 'CLOSED', estateId: 'e1', tenantId: 'n1' }));
    await expect(mpesaReferenceService.issue(args)).rejects.toMatchObject({ status: 422 });
    tenancyFindOne.mockReturnValue(chain({ _id: 't1', status: 'ACTIVE', estateId: 'e1', tenantId: 'n1' }));
    isActiveMapping.mockResolvedValue(false);
    await expect(mpesaReferenceService.issue(args)).rejects.toMatchObject({ status: 422 });
    expect(create).not.toHaveBeenCalled();
  });
});

describe('duplicateKeyIndex classification', () => {
  test('classifies by index name, then by key pattern; ignores non-duplicate errors', () => {
    expect(duplicateKeyIndex(dup('uniq_mpesa_ref_active_tenancy'))).toBe('active_tenancy');
    expect(duplicateKeyIndex(dup('uniq_mpesa_ref_merchant_reference'))).toBe('reference');
    expect(duplicateKeyIndex({ code: 11000, message: 'x', keyPattern: { merchantProfileId: 1, tenancyId: 1 } })).toBe('active_tenancy');
    expect(duplicateKeyIndex({ code: 11000, message: 'x', keyPattern: { merchantProfileId: 1, reference: 1 } })).toBe('reference');
    expect(duplicateKeyIndex({ code: 11000, message: 'x' })).toBe('unknown');
    expect(duplicateKeyIndex(new Error('boom'))).toBeNull();
  });
});
