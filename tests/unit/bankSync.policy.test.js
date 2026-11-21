import '../setup.js';
import { hasBankSyncEntitlement } from '../../src/services/banking/bankSync.service.js';
import {
  assertProviderCapabilityOperational,
  getBankProviderCapabilities,
} from '../../src/services/banking/bank.factory.js';

describe('bank sync entitlement policy', () => {
  test('poll entitlement cannot authorize the FullStatement strategy', () => {
    expect(
      hasBankSyncEntitlement({ poll: true, statement: false }, 'statement')
    ).toBe(false);
  });

  test('statement entitlement authorizes the FullStatement strategy without poll', () => {
    expect(
      hasBankSyncEntitlement({ poll: false, statement: true }, 'statement')
    ).toBe(true);
  });

  test('poll entitlement is recognized only when a poll strategy explicitly requires it', () => {
    expect(
      hasBankSyncEntitlement({ poll: true, statement: false }, 'poll')
    ).toBe(true);
    expect(
      hasBankSyncEntitlement({ poll: false, statement: true }, 'poll')
    ).toBe(false);
  });

  test('unknown or absent strategy requirements fail closed', () => {
    expect(hasBankSyncEntitlement({ poll: true, statement: true }, null)).toBe(false);
    expect(hasBankSyncEntitlement({ poll: false, statement: false }, 'statement')).toBe(false);
    expect(hasBankSyncEntitlement({}, 'statement')).toBe(false);
  });
});

describe('provider capability readiness policy', () => {
  test('Co-op statement import requires readiness or the non-production lab override', () => {
    expect(() => assertProviderCapabilityOperational('COOP', 'statementImport', {
      allowLab: true,
      labMode: false,
      nodeEnv: 'test',
    })).toThrow(/not operationally ready/i);

    expect(
      assertProviderCapabilityOperational('COOP', 'statementImport', {
        allowLab: true,
        labMode: true,
        nodeEnv: 'test',
      })
    ).toBe(getBankProviderCapabilities('COOP'));
  });

  test('production cannot use the Co-op statement lab override', () => {
    expect(() => assertProviderCapabilityOperational('COOP', 'statementImport', {
      allowLab: true,
      labMode: true,
      nodeEnv: 'production',
    })).toThrow(/not operationally ready/i);
  });

  test('the statement lab override cannot enable disabled webhook capability', () => {
    expect(() => assertProviderCapabilityOperational('COOP', 'webhook', {
      allowLab: true,
      labMode: true,
      nodeEnv: 'test',
    })).toThrow(/does not implement capability/i);
  });
});
