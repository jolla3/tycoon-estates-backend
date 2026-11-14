import { describe, test, expect } from '@jest/globals';
import { buildProtectedSmsAad } from '../../../src/services/g5ProtectedSms.service.js';

describe('G5 protected SMS AAD', () => {
  test('binds full notification identity', () => {
    const a = buildProtectedSmsAad({
      messageId: 'm1', clientId: 'c1', estateId: 'e1', tenantId: 't1',
      linkId: 'l1', linkVersion: 3, type: 'g5_onboarding_link',
      notificationVersion: 'g5_onboarding_link:v1', idempotencyKey: 'g5:key',
    });
    expect(a).toContain('m1');
    expect(a).toContain('c1');
    expect(a).toContain('e1');
    expect(a).toContain('t1');
    expect(a).toContain('l1');
    expect(a).toContain(':3:');
    expect(a).toContain('g5_onboarding_link');
  });

  test('identity change alters AAD', () => {
    const base = {
      messageId: 'm1', clientId: 'c1', estateId: 'e1', tenantId: 't1',
      linkId: 'l1', linkVersion: 1, type: 'payment_confirmation',
      notificationVersion: 'payment_confirmation:v1', idempotencyKey: 'g5:k',
    };
    const a = buildProtectedSmsAad(base);
    const b = buildProtectedSmsAad({ ...base, linkVersion: 2 });
    expect(a).not.toBe(b);
  });
});
