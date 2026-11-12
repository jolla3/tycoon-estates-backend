import '../setup.js';
import { hasBankSyncEntitlement } from '../../src/services/banking/bankSync.service.js';

describe('bank sync entitlement policy', () => {
  test('poll entitlement permits sync', () => {
    expect(hasBankSyncEntitlement({ poll: true, statement: false })).toBe(true);
  });

  test('statement-only entitlement permits FullStatement sync', () => {
    expect(hasBankSyncEntitlement({ poll: false, statement: true })).toBe(true);
  });

  test('no polling or statement entitlement blocks sync', () => {
    expect(hasBankSyncEntitlement({ poll: false, statement: false })).toBe(false);
    expect(hasBankSyncEntitlement({})).toBe(false);
  });
});
