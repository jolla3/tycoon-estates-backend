import { listBankProviders, getBankProviderCapabilities, getBankProvider } from '../../src/services/banking/bank.factory.js';

describe('bank provider registry', () => {
  test('lists known providers with COOP implemented', () => {
    const list = listBankProviders();
    expect(list.find((p) => p.name === 'COOP')?.implemented).toBe(true);
    expect(list.find((p) => p.name === 'KCB')?.implemented).toBe(false);
    expect(list.find((p) => p.name === 'EQUITY')?.implemented).toBe(false);
    expect(list.find((p) => p.name === 'NCBA')?.implemented).toBe(false);
  });

  test('getBankProviderCapabilities returns null for unknown', () => {
    expect(getBankProviderCapabilities('UNKNOWN')).toBeNull();
  });

  test('getBankProvider throws for unimplemented provider', () => {
    expect(() => getBankProvider('KCB')).toThrow(/Unsupported bank provider/);
  });
});
