import { jest } from '@jest/globals';

let estateDoc;
let houseTypeDoc;
let effectiveVersionDoc;
let anyVersionDoc;
let configDocs;

function query(value) {
  const q = {
    session: jest.fn(() => q),
    lean: jest.fn(async () => value),
    sort: jest.fn(() => q),
    select: jest.fn(() => q),
  };
  return q;
}

const uniquePlanLines = (lines) => {
  const seen = new Set();
  for (const line of lines || []) {
    const key = `${line.chargeType}::${String(line.description || '').trim().toLowerCase()}`;
    if (seen.has(key)) throw new Error('duplicate plan line');
    seen.add(key);
  }
};

jest.unstable_mockModule('../../src/models/Estate.js', () => ({
  Estate: { findOne: jest.fn(() => query(estateDoc)) },
}));

jest.unstable_mockModule('../../src/models/HouseBillingConfig.js', () => ({
  HouseBillingConfig: {
    find: jest.fn(() => query(configDocs)),
  },
}));

jest.unstable_mockModule('../../src/models/HouseType.js', () => ({
  HouseType: { findOne: jest.fn(() => query(houseTypeDoc)) },
  assertUniquePlanLines: uniquePlanLines,
}));

jest.unstable_mockModule('../../src/models/HouseTypePlanVersion.js', () => ({
  HouseTypePlanVersion: {
    findOne: jest.fn((filter) => query(
      Object.prototype.hasOwnProperty.call(filter, 'effectiveFromPeriod')
        ? effectiveVersionDoc
        : anyVersionDoc
    )),
  },
}));

const { resolveHouseBillingPlan, resolveRegistrationBillingPlan } = await import('../../src/services/houseBillingPlan.service.js');

const houseTypeId = '64a000000000000000000001';
const estateId = '64a000000000000000000002';
const clientId = '64a000000000000000000003';
const registrationAt = new Date('2026-11-15T09:00:00.000Z');

function makeHouse(overrides = {}) {
  return {
    _id: '64a000000000000000000004',
    clientId,
    estateId,
    houseTypeId,
    billingSource: 'HOUSE_TYPE',
    dueDay: 10,
    ...overrides,
  };
}

beforeEach(() => {
  jest.clearAllMocks();
  estateDoc = { _id: estateId, clientId, name: 'Test Estate', currency: 'KES', defaultDueDay: 18 };
  houseTypeDoc = {
    _id: houseTypeId,
    clientId,
    estateId,
    planVersion: 3,
    defaultBilling: [
      { lineId: 'rent', chargeType: 'RENT', description: 'Rent', amountCents: 800000, dueDay: 5 },
      { lineId: 'water', chargeType: 'WATER', description: 'Water', amountCents: 50000 },
      { lineId: 'security', chargeType: 'OTHER', description: 'Security', amountCents: 30000, dueDay: 12 },
    ],
  };
  effectiveVersionDoc = null;
  anyVersionDoc = null;
  configDocs = [];
});

describe('HouseType registration billing snapshot', () => {
  test('uses canonical defaultBilling when a legacy HouseType has no plan-version history', async () => {
    const session = { id: 'registration-session' };
    const result = await resolveRegistrationBillingPlan(
      makeHouse({ billingSource: 'LEGACY_UNCLASSIFIED' }),
      registrationAt,
      { session }
    );

    expect(result).toMatchObject({
      source: 'HOUSE_TYPE',
      outcome: 'OK',
      lines: [
        { chargeType: 'RENT', description: 'Rent', amountCents: 800000, dueDay: 5, planLineId: 'rent' },
        { chargeType: 'WATER', description: 'Water', amountCents: 50000, dueDay: 10, planLineId: 'water' },
        { chargeType: 'OTHER', description: 'Security', amountCents: 30000, dueDay: 12, planLineId: 'security' },
      ],
      planMeta: { planId: houseTypeId, planVersionId: null, planVersion: 3 },
      registrationAt,
    });
  });

  test('uses the effective period version when one exists, not the editable current defaultBilling mirror', async () => {
    effectiveVersionDoc = {
      _id: '64a000000000000000000005',
      version: 2,
      effectiveFromPeriod: '2026-10',
      lines: [
        { lineId: 'old-rent', chargeType: 'RENT', description: 'Rent', amountCents: 650000, dueDay: 7 },
      ],
    };

    const result = await resolveRegistrationBillingPlan(makeHouse(), registrationAt);

    expect(result.lines).toEqual([
      { chargeType: 'RENT', description: 'Rent', amountCents: 650000, dueDay: 7, planLineId: 'old-rent' },
    ]);
    expect(result.planMeta.planVersion).toBe(2);
  });

  test('does not expose defaultBilling early when version history exists only for a future period', async () => {
    anyVersionDoc = { _id: '64a000000000000000000006', effectiveFromPeriod: '2026-12' };

    const result = await resolveRegistrationBillingPlan(makeHouse(), registrationAt);

    expect(result).toMatchObject({
      outcome: 'NO_EFFECTIVE_HOUSE_TYPE_VERSION',
      source: 'HOUSE_TYPE',
      lines: [],
    });
  });

  test('does not infer HouseType billing for an unclassified House without a HouseType link', async () => {
    const result = await resolveRegistrationBillingPlan(
      makeHouse({ houseTypeId: null, billingSource: 'LEGACY_UNCLASSIFIED' }),
      registrationAt
    );

    expect(result).toMatchObject({
      outcome: 'LEGACY_UNCLASSIFIED',
      source: 'LEGACY_UNCLASSIFIED',
      lines: [],
    });
  });

  test('explicit HOUSE_CONFIG source takes precedence over a HouseType link', async () => {
    configDocs = [{
      _id: '64a000000000000000000007',
      chargeType: 'OTHER',
      description: 'Parking',
      amountCents: 15000,
      dueDay: 9,
    }];

    const result = await resolveRegistrationBillingPlan(
      makeHouse({ billingSource: 'HOUSE_CONFIG' }),
      registrationAt
    );

    expect(result).toMatchObject({
      source: 'HOUSE_CONFIG',
      outcome: 'OK',
      lines: [{ chargeType: 'OTHER', description: 'Parking', amountCents: 15000, dueDay: 9 }],
    });
  });

  test('keeps a valid empty defaultBilling array distinct from a missing field', async () => {
    houseTypeDoc = { ...houseTypeDoc, defaultBilling: [] };

    const result = await resolveRegistrationBillingPlan(makeHouse(), registrationAt);

    expect(result).toMatchObject({
      source: 'HOUSE_TYPE',
      outcome: 'VALID_EMPTY_HOUSE_TYPE_PLAN',
      lines: [],
    });
  });

  test('fails closed when a legacy HouseType has no canonical defaultBilling field', async () => {
    houseTypeDoc = { ...houseTypeDoc };
    delete houseTypeDoc.defaultBilling;

    await expect(resolveRegistrationBillingPlan(makeHouse(), registrationAt))
      .rejects.toThrow('HouseType default billing is missing');
  });

  test('passes the caller session to every registration billing read', async () => {
    const session = { id: 'shared-session' };

    await resolveRegistrationBillingPlan(makeHouse(), registrationAt, { session });

    const { Estate } = await import('../../src/models/Estate.js');
    const { HouseType } = await import('../../src/models/HouseType.js');
    const { HouseTypePlanVersion } = await import('../../src/models/HouseTypePlanVersion.js');

    expect(Estate.findOne).toHaveBeenCalledWith({ _id: estateId, clientId });
    expect(HouseType.findOne).toHaveBeenCalledWith({ _id: houseTypeId, clientId, estateId });
    expect(Estate.findOne.mock.results[0].value.session).toHaveBeenCalledWith(session);
    expect(HouseType.findOne.mock.results[0].value.session).toHaveBeenCalledWith(session);
    const planHistoryQueries = HouseTypePlanVersion.findOne.mock.results.map((result) => result.value);
    expect(planHistoryQueries).toHaveLength(2);
    for (const planHistoryQuery of planHistoryQueries) {
      expect(planHistoryQuery.session).toHaveBeenCalledWith(session);
    }
  });

  test('does not apply registration compatibility to monthly charge generation', async () => {
    await expect(resolveHouseBillingPlan(
      makeHouse({ billingSource: 'LEGACY_UNCLASSIFIED' }),
      { kind: 'CHARGE_PERIOD', period: '2026-11' }
    )).rejects.toThrow('unclassified legacy billing source');
  });
});
