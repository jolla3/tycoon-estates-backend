import { mpesaTransactionListSchema } from '../../src/routes/mpesaTransaction.routes.js';

describe('M-PESA transaction list query schema', () => {
  test('accepts supported pagination and receipt filters', () => {
    const parsed = mpesaTransactionListSchema.safeParse({
      page: '2', limit: '50', estateId: '64b7f0a1c2d3e4f5a6b7c8d9',
      verificationState: 'MATCHED', postingState: 'POSTED',
    });
    expect(parsed.success).toBe(true);
    expect(parsed.data.page).toBe(2);
    expect(parsed.data.limit).toBe(50);
  });

  test('rejects unsupported state and reversed date ranges', () => {
    expect(mpesaTransactionListSchema.safeParse({ verificationState: 'APPROVED' }).success).toBe(false);
    expect(mpesaTransactionListSchema.safeParse({
      startDate: '2026-11-20', endDate: '2026-11-19',
    }).success).toBe(false);
  });
});
