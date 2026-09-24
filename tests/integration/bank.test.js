import '../setup.js';
import { describeWithMongo, connectTestDb, clearTestDb, disconnectTestDb } from '../helpers/db.js';
import { getBankProvider } from '../../src/services/banking/bank.factory.js';
import { CoopBankProvider } from '../../src/services/banking/providers/coop/coop.provider.js';

describeWithMongo('Bank provider factory', () => {
  beforeAll(connectTestDb);
  afterEach(clearTestDb);
  afterAll(disconnectTestDb);

  test('getBankProvider("COOP") returns a CoopBankProvider', () => {
    const provider = getBankProvider('COOP');
    expect(provider).toBeInstanceOf(CoopBankProvider);
    expect(provider.getProviderName()).toBe('COOP');
  });

  test('an unsupported provider throws BANK_PROVIDER_UNAVAILABLE', () => {
    expect(() => getBankProvider('KCB')).toThrow(/KCB/);
  });

  test('the same provider name returns the same cached instance', () => {
    expect(getBankProvider('COOP')).toBe(getBankProvider('COOP'));
  });
});
