import {
  REQUIRED_MODELS,
  areFinancialIndexReportsAligned,
} from '../../src/utils/ensureIndexes.js';

describe('financial index readiness requirements', () => {
  test('requires Subscription and DepositMovement, not AccountCompleteness', () => {
    expect(REQUIRED_MODELS).toEqual(expect.arrayContaining([
      'Subscription',
      'DepositMovement',
    ]));
    expect(REQUIRED_MODELS).not.toContain('AccountCompleteness');
  });

  test('DepositMovement index is a required financial readiness gate', () => {
    const reports = {
      billing: { aligned: true },
      houseTypeIndexes: { aligned: true },
      manualPaymentIndex: { aligned: true },
      depositMovementIndex: { aligned: true },
    };

    expect(areFinancialIndexReportsAligned(reports)).toBe(true);
    expect(areFinancialIndexReportsAligned({
      ...reports,
      depositMovementIndex: { aligned: false },
    })).toBe(false);
  });
});
