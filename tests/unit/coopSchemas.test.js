import '../setup.js';
import {
  AccountTransactionsRequest,
  AccountFullStatementRequest,
  AccountBalanceRequest,
  isCoopSuccess,
} from '../../src/services/banking/providers/coop/coop.schemas.js';

describe('Co-op request schemas (exactly as documented)', () => {
  test('AccountNumber must be exactly 14 characters, per every documented endpoint', () => {
    expect(() => AccountBalanceRequest.parse({ MessageReference: 'ref', AccountNumber: 'tooShort' })).toThrow();
    expect(() => AccountBalanceRequest.parse({ MessageReference: 'ref', AccountNumber: '36001873000000' })).not.toThrow();
  });

  test('AccountTransactionsRequest requires NoOfTransactions', () => {
    expect(() => AccountTransactionsRequest.parse({ MessageReference: 'ref', AccountNumber: '36001873000000' })).toThrow();
    expect(() => AccountTransactionsRequest.parse({ MessageReference: 'ref', AccountNumber: '36001873000000', NoOfTransactions: 10 })).not.toThrow();
  });

  test('AccountFullStatementRequest requires a date range', () => {
    expect(() =>
      AccountFullStatementRequest.parse({ MessageReference: 'ref', AccountNumber: '36001873000000', StartDate: '2026-01-01', EndDate: '2026-02-01' })
    ).not.toThrow();
  });

  test('MessageReference is capped at 27 characters per the documented constraint', () => {
    const tooLong = 'x'.repeat(28);
    expect(() => AccountBalanceRequest.parse({ MessageReference: tooLong, AccountNumber: '36001873000000' })).toThrow();
  });

  test('isCoopSuccess treats MessageCode "0" (string or number) as success, everything else as failure', () => {
    expect(isCoopSuccess({ MessageCode: '0' })).toBe(true);
    expect(isCoopSuccess({ MessageCode: 0 })).toBe(true);
    expect(isCoopSuccess({ MessageCode: '401' })).toBe(false);
    expect(isCoopSuccess({})).toBe(false);
  });
});
