import {
  assessRentChargeIndexes,
  GENERATED_LEGACY_HOUSE_UNIQUE_NAME,
  isExactObsoleteHouseRentChargeIndex,
  LEGACY_HOUSE_UNIQUE_KEYS,
} from '../../src/utils/rentChargeIndexDefinitions.js';

const generatedIndex = {
  name: GENERATED_LEGACY_HOUSE_UNIQUE_NAME,
  key: LEGACY_HOUSE_UNIQUE_KEYS,
  unique: true,
  sparse: false,
  partialFilterExpression: undefined,
  collation: undefined,
};

describe('RentCharge identity index classification', () => {
  test('recognizes the exact historical key with MongoDB-generated default name', () => {
    expect(isExactObsoleteHouseRentChargeIndex(generatedIndex)).toBe(true);

    const report = assessRentChargeIndexes([generatedIndex]);
    expect(report.exactObsoleteIndexes).toHaveLength(1);
    expect(report.suspiciousHouseUniqueIndexes).toHaveLength(0);
  });

  test('continues to recognize the explicit legacy migration name', () => {
    expect(isExactObsoleteHouseRentChargeIndex({
      ...generatedIndex,
      name: 'uniq_house_period_charge_desc',
    })).toBe(true);
  });

  test('does not accept an unknown name even when the key pattern looks similar', () => {
    const unknown = { ...generatedIndex, name: 'custom_house_unique' };
    expect(isExactObsoleteHouseRentChargeIndex(unknown)).toBe(false);

    const report = assessRentChargeIndexes([unknown]);
    expect(report.exactObsoleteIndexes).toHaveLength(0);
    expect(report.suspiciousHouseUniqueIndexes).toHaveLength(1);
  });

  test.each([
    ['sparse', { sparse: true }],
    ['collation', { collation: { locale: 'en', strength: 2 } }],
    ['partial filter', { partialFilterExpression: { clientId: { $exists: true } } }],
  ])('does not accept a historical-looking index with unsafe %s options', (_label, overrides) => {
    expect(isExactObsoleteHouseRentChargeIndex({
      ...generatedIndex,
      ...overrides,
    })).toBe(false);
  });
});
