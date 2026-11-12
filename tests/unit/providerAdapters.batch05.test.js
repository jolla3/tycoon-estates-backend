import '../setup.js';
import {
  listBankProviders,
  listOperationalBankProviders,
  listRegisteredBankProviders,
  getBankProviderCapabilities,
  getProviderReadiness,
  createBankProviderForConnection,
  getBankProvider,
  assertProviderOperational,
} from '../../src/services/banking/bank.factory.js';
import { KcbBankProvider } from '../../src/services/banking/providers/kcb/kcb.provider.js';
import { EquityBankProvider } from '../../src/services/banking/providers/equity/equity.provider.js';
import { NcbaBankProvider } from '../../src/services/banking/providers/ncba/ncba.provider.js';
import { CoopBankProvider } from '../../src/services/banking/providers/coop/coop.provider.js';

describe('Batch 05 provider registry and isolation', () => {
  test('all four identifiers remain registered', () => {
    const names = listBankProviders().map((p) => p.name).sort();
    expect(names).toEqual(['COOP', 'EQUITY', 'KCB', 'NCBA']);
  });

  test('registered adapters exist for all four; operational list is empty without live verification', () => {
    expect(listRegisteredBankProviders()).toHaveLength(4);
    expect(listOperationalBankProviders()).toHaveLength(0);
  });

  test('COOP is implemented but not operationalReady without sandbox verification', () => {
    const caps = getBankProviderCapabilities('COOP');
    expect(caps.implemented).toBe(true);
    expect(caps.operationalReady).toBe(false);
    expect(caps.polling).toBe(false);
    expect(caps.statementImport).toBe(true);
  });

  test('KCB EQUITY NCBA are not implemented/operational', () => {
    for (const name of ['KCB', 'EQUITY', 'NCBA']) {
      const caps = getBankProviderCapabilities(name);
      expect(caps.implemented).toBe(false);
      expect(caps.operationalReady).toBe(false);
      expect(assertProviderOperational.bind(null, name)).toThrow(/not operationally implemented|Unsupported/);
    }
  });

  test('readiness profiles expose multi-dimensional capability state', () => {
    const coop = getProviderReadiness('COOP');
    expect(coop.capabilities.polling.operationalReady).toBe(false);
    expect(coop.capabilities.statementImport.capabilityImplemented).toBe(true);
    expect(coop.capabilities.polling.blockers.length).toBeGreaterThan(0);

    const kcb = getProviderReadiness('KCB');
    expect(kcb.operationalReady).toBe(false);
    expect(kcb.adapterPresent).toBe(true);
  });

  test('disabled providers throw typed unsupported errors — no empty success', async () => {
    const kcb = new KcbBankProvider({ clientId: 'x' });
    await expect(kcb.authenticate()).rejects.toMatchObject({ code: 'BANK_CAPABILITY_UNSUPPORTED' });
    await expect(kcb.getTransactions({})).rejects.toMatchObject({ code: 'BANK_CAPABILITY_UNSUPPORTED' });
    await expect(kcb.validateAccount({})).rejects.toMatchObject({ code: 'BANK_CAPABILITY_UNSUPPORTED' });

    const equity = new EquityBankProvider({});
    await expect(equity.getFullStatement({}, 'a', 'b')).rejects.toMatchObject({
      code: 'BANK_CAPABILITY_UNSUPPORTED',
    });

    const ncba = new NcbaBankProvider({});
    expect(() => ncba.normalizeTransaction({})).toThrow(/BANK_CAPABILITY_UNSUPPORTED|not operational/);
  });

  test('createBankProviderForConnection does not share instances across connections', () => {
    const a = createBankProviderForConnection('COOP', {
      clientId: 'a', clientSecret: 'a', username: 'a', password: 'a', scope: 's',
    }, { connectionId: 'c1', credentialVersion: 1 });
    const b = createBankProviderForConnection('COOP', {
      clientId: 'b', clientSecret: 'b', username: 'b', password: 'b', scope: 's',
    }, { connectionId: 'c2', credentialVersion: 2 });
    expect(a).not.toBe(b);
    expect(a).toBeInstanceOf(CoopBankProvider);
    expect(a.connectionId).toBe('c1');
    expect(b.credentialVersion).toBe(2);
  });

  test('disabled adapters are distinct classes and never fall through to COOP', () => {
    const kcb = createBankProviderForConnection('KCB', { token: 'x' });
    expect(kcb).toBeInstanceOf(KcbBankProvider);
    expect(kcb.getProviderName()).toBe('KCB');
    expect(kcb).not.toBeInstanceOf(CoopBankProvider);
  });

  test('getBankProvider rejects unimplemented providers', () => {
    expect(() => getBankProvider('KCB')).toThrow();
  });
});
