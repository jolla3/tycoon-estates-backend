/**
 * Unit-level behaviour of sync coordination helpers.
 * Mongo paths are asserted via query shape documentation tests where DB is unavailable.
 */
import '../setup.js';
import {
  newSyncWorkerId,
} from '../../src/services/banking/syncCoordination.service.js';
import { createCoopSyncStrategy, CoopUnverifiedTransactionsPollStrategy } from '../../src/services/banking/providers/coop/coop.syncStrategy.js';
import { digestPayload, callbackQuarantineService } from '../../src/services/banking/callbackQuarantine.service.js';
import { getBankProviderCapabilities } from '../../src/services/banking/bank.factory.js';
import { BankAccount } from '../../src/models/BankAccount.js';

describe('sync coordination primitives', () => {
  test('worker ids are unique opaque tokens', () => {
    const a = newSyncWorkerId();
    const b = newSyncWorkerId();
    expect(a).not.toBe(b);
    expect(a.startsWith('sync-')).toBe(true);
  });

  test('BankAccount schema includes fence and checkpoint fields', () => {
    const paths = BankAccount.schema.paths;
    expect(paths['sync.fenceGeneration']).toBeTruthy();
    expect(paths['sync.leaseOwner']).toBeTruthy();
    expect(paths['sync.checkpoint.type']).toBeTruthy();
    expect(paths['sync.checkpoint.acceptedThrough']).toBeTruthy();
  });
});

describe('Co-op sync strategy policy', () => {
  test('full statement window strategy is operational; AccountTransactions poll is not', () => {
    expect(createCoopSyncStrategy().supportsOperationalSync()).toBe(true);
    expect(new CoopUnverifiedTransactionsPollStrategy().supportsOperationalSync()).toBe(false);
  });

  test('registry marks Co-op list polling non-operational while statement import remains available', () => {
    const caps = getBankProviderCapabilities('COOP');
    expect(caps.polling).toBe(false);
    expect(caps.statementImport).toBe(true);
    expect(caps.webhook).toBe(true);
  });
});

describe('callback quarantine redaction', () => {
  test('digest is stable for same payload', () => {
    const body = { AccountNumber: '36001873000000', Amount: 10 };
    expect(digestPayload(body)).toBe(digestPayload(body));
    expect(digestPayload(body)).not.toBe(digestPayload({ ...body, Amount: 11 }));
  });

  test('redacts sensitive keys', () => {
    const red = callbackQuarantineService.redact({
      AccountNumber: '36001873000000',
      password: 'secret',
      Authorization: 'Basic xxx',
      nested: { access_token: 'tok', Narration: 'rent' },
    });
    expect(red.password).toBe('[redacted]');
    expect(red.Authorization).toBe('[redacted]');
    expect(red.nested.access_token).toBe('[redacted]');
    expect(red.nested.Narration).toBe('rent');
    expect(red.AccountNumber).toBe('36001873000000');
  });
});
