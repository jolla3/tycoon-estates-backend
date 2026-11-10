import { jest } from '@jest/globals';
import {
  inspectMalformedIdentityFields,
} from '../../scripts/migrations/20261109_rentcharge_tenancy_index.js';

describe('RentCharge tenancy-index migration preflight', () => {
  test('validates identity field types only inside the target partial-index scope', async () => {
    const collection = {
      aggregate: jest.fn(() => ({
        toArray: async () => [],
      })),
    };

    await expect(
      inspectMalformedIdentityFields(collection),
    ).resolves.toEqual([]);

    const pipeline = collection.aggregate.mock.calls[0][0];

    expect(pipeline[0]).toEqual({
      $match: {
        $expr: {
          $eq: [
            { $type: '$tenancyId' },
            'objectId',
          ],
        },
      },
    });

    expect(pipeline[1]).toHaveProperty('$project.fields');

    expect(
      pipeline[1].$project.fields.map((field) => field.name),
    ).toEqual([
      'period',
      'chargeType',
      'description',
    ]);
  });

  test('still reports malformed identity fields among tenancy-attributed rows', async () => {
    const rows = [{
      _id: {
        field: 'chargeType',
        bsonType: 'missing',
      },
      count: 1,
      sampleId: '65f000000000000000000001',
    }];

    const collection = {
      aggregate: jest.fn(() => ({
        toArray: async () => rows,
      })),
    };

    await expect(
      inspectMalformedIdentityFields(collection),
    ).resolves.toEqual([
      {
        field: 'chargeType',
        bsonType: 'missing',
        count: 1,
        sampleId: '65f000000000000000000001',
      },
    ]);

    const pipeline = collection.aggregate.mock.calls[0][0];

    expect(pipeline[0]).toEqual({
      $match: {
        $expr: {
          $eq: [
            { $type: '$tenancyId' },
            'objectId',
          ],
        },
      },
    });

    expect(
      pipeline[1].$project.fields.map((field) => field.name),
    ).toEqual([
      'period',
      'chargeType',
      'description',
    ]);
  });
});
