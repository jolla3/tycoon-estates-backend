import '../setup.js';
import { extractAccountNumber } from '../../src/services/banking/providers/coop/coop.mapper.js';

describe('Co-op extractAccountNumber (CONFIRMED per the supplied docs: SendTransactionINS.AccountNumber, 14 chars)', () => {
  test('reads AccountNumber when present', () => {
    expect(extractAccountNumber({ AccountNumber: '00112233445566' })).toBe('00112233445566');
  });

  test('returns null when AccountNumber is absent — the webhook must fail loudly here, never silently pick some other account', () => {
    expect(extractAccountNumber({ TransactionId: 'TXN1', Amount: 100 })).toBeNull();
  });
});
