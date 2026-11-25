import '../../setup.js';
import { jest, describe, test, expect, beforeEach } from '@jest/globals';

let mappings = [];
let profiles = [];
let mappingFilter;
let profileFilter;
const query = (value) => ({
  session() { return this; },
  select() { return this; },
  lean: async () => value,
  then(resolve, reject) { return Promise.resolve(value).then(resolve, reject); },
});

jest.unstable_mockModule('../../../src/models/MpesaMerchantProfileEstate.js', () => ({
  MpesaMerchantProfileEstate: {
    find: (filter) => { mappingFilter = filter; return query(mappings); },
  },
}));
jest.unstable_mockModule('../../../src/models/MpesaMerchantProfile.js', () => ({
  MpesaMerchantProfile: {
    find: (filter) => { profileFilter = filter; return query(profiles); },
  },
}));

const { resolveRegistrationTillMerchant } = await import('../../../src/services/mpesa/mpesaMerchantMapping.service.js');

beforeEach(() => {
  mappings = [{ merchantProfileId: 'till-1' }];
  profiles = [{ _id: 'till-1', clientId: 'client-1', merchantType: 'BUY_GOODS_TILL', operationalState: 'DRAFT', businessShortCode: '8965322' }];
  mappingFilter = null;
  profileFilter = null;
});

describe('registration link merchant eligibility', () => {
  test('allows a mapped DRAFT Buy Goods Till for link/preview provisioning', async () => {
    const result = await resolveRegistrationTillMerchant('client-1', 'estate-1');
    expect(result).toMatchObject({ merchant: profiles[0], ambiguous: false });
    expect(mappingFilter).toMatchObject({ clientId: 'client-1', estateId: 'estate-1', status: 'ACTIVE' });
    expect(profileFilter).toMatchObject({
      clientId: 'client-1',
      merchantType: 'BUY_GOODS_TILL',
      operationalState: { $in: ['DRAFT', 'NOT_READY', 'ACTIVE'] },
    });
  });

  test('never selects a PAYBILL or SUSPENDED profile as the tenant Till link', async () => {
    profiles = [
      { _id: 'paybill', merchantType: 'PAYBILL', operationalState: 'ACTIVE' },
      { _id: 'suspended', merchantType: 'BUY_GOODS_TILL', operationalState: 'SUSPENDED' },
    ];
    const result = await resolveRegistrationTillMerchant('client-1', 'estate-1');
    expect(result).toEqual({ merchant: null, ambiguous: false });
  });

  test('does not choose arbitrarily when multiple eligible Till profiles are mapped', async () => {
    mappings = [{ merchantProfileId: 'till-1' }, { merchantProfileId: 'till-2' }];
    profiles = [
      { _id: 'till-1', merchantType: 'BUY_GOODS_TILL', operationalState: 'DRAFT' },
      { _id: 'till-2', merchantType: 'BUY_GOODS_TILL', operationalState: 'ACTIVE' },
    ];
    const result = await resolveRegistrationTillMerchant('client-1', 'estate-1');
    expect(result).toEqual({ merchant: null, ambiguous: true });
  });

  test('an explicit existing profile must still be mapped and eligible', async () => {
    const result = await resolveRegistrationTillMerchant('client-1', 'estate-1', { merchantProfileId: 'other-client-till' });
    expect(result).toEqual({ merchant: null, ambiguous: false });
  });
});
