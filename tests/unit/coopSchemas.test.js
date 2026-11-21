import '../setup.js';
import {
  AccountTransactionsRequest,
  AccountFullStatementRequest,
  AccountValidationRequest,
  isCoopSuccess,
  getCoopMessageCode,
} from '../../src/services/banking/providers/coop/coop.schemas.js';

describe('Co-op request schemas (resource-specific)', () => {
  test('FullStatement AccountNumber is 14 characters', () => {
    expect(() =>
      AccountFullStatementRequest.parse({
        MessageReference: 'ref',
        AccountNumber: 'tooShort',
        StartDate: '2026-01-01',
        EndDate: '2026-02-01',
      })
    ).toThrow();
    expect(() =>
      AccountFullStatementRequest.parse({
        MessageReference: 'ref',
        AccountNumber: '36001873000000',
        StartDate: '2026-01-01',
        EndDate: '2026-02-01',
      })
    ).not.toThrow();
  });

  test('Account Validation accepts documented 11-digit example', () => {
    expect(() =>
      AccountValidationRequest.parse({
        MessageReference: 'ref',
        AccountNumber: '36001873000',
      })
    ).not.toThrow();
  });

  test('AccountTransactionsRequest requires NoOfTransactions as string <= 500', () => {
    expect(() =>
      AccountTransactionsRequest.parse({
        MessageReference: 'ref',
        AccountNumber: '36001873000000',
        NoOfTransactions: '10',
      })
    ).not.toThrow();
    expect(() =>
      AccountTransactionsRequest.parse({
        MessageReference: 'ref',
        AccountNumber: '36001873000000',
        NoOfTransactions: 10,
      })
    ).toThrow();
    expect(() =>
      AccountTransactionsRequest.parse({
        MessageReference: 'ref',
        AccountNumber: '36001873000000',
        NoOfTransactions: '501',
      })
    ).toThrow();
  });

  test('isCoopSuccess and getCoopMessageCode', () => {
    expect(isCoopSuccess({ MessageCode: '0' })).toBe(true);
    expect(isCoopSuccess({ MessageCode: 0 })).toBe(true);
    expect(isCoopSuccess({ MessageCode: '-1' })).toBe(false);
    expect(getCoopMessageCode({ MessageCode: -1 })).toBe('-1');
    expect(getCoopMessageCode({})).toBeNull();
  });
});
