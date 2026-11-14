import { describe, test, expect } from '@jest/globals';
import {
  extractPullRows,
  queryPullTransactions,
} from '../../../src/services/mpesa/darajaPull.service.js';

describe('extractPullRows', () => {
  test('distinguishes empty bodies from unsupported responses', () => {
    expect(extractPullRows(null)).toEqual({ shape: 'empty_body', rows: [] });
    expect(extractPullRows('x')).toEqual({ shape: 'unsupported', rows: [] });
    expect(extractPullRows({ unexpected: true })).toEqual({ shape: 'unsupported', rows: [] });
  });

  test('accepts legacy top-level rows but does not trust an unscoped empty array', () => {
    const rows = [{ TransID: '1' }];
    expect(extractPullRows(rows)).toEqual({ shape: 'rows', rows });
    expect(extractPullRows([])).toEqual({ shape: 'unsupported', rows: [] });
  });

  test('accepts legacy flat response envelopes but not unscoped empty arrays', () => {
    for (const key of ['Response', 'transactions', 'Transactions', 'data']) {
      const rows = [{ a: 1 }];
      expect(extractPullRows({ [key]: rows })).toEqual({ shape: 'rows', rows });
      expect(extractPullRows({ [key]: [] })).toEqual({ shape: 'unsupported', rows: [] });
    }
  });

  test('flattens the documented nested Response array for ResponseCode 1000', () => {
    const row = {
      transactionId: 'LHG31AA5TX',
      trxDate: '2020-08-05T10:13:00Z',
      msisdn: 722000000,
      sender: 'UAT2',
      transactiontype: 'c2b-pay-bill-debit',
      billreference: '37207636392',
      amount: '168.00',
      organizationname: 'Daraja Pull API Test',
    };
    expect(extractPullRows({
      ResponseRefID: '26178-42530161-2',
      ResponseCode: '1000',
      ResponseMessage: 'Success',
      Response: [[row]],
    })).toEqual({ shape: 'rows', rows: [row] });
  });

  test('treats documented ResponseCode 1001 as an explicit empty window', () => {
    expect(extractPullRows({
      ResponseRefID: 'ref',
      ResponseCode: '1001',
      ResponseMessage: 'No transactions available',
      Response: [[]],
    })).toEqual({ shape: 'empty_valid', rows: [] });
    expect(extractPullRows({ ResponseCode: '1001' })).toEqual({ shape: 'empty_valid', rows: [] });
  });

  test('does not treat an empty 1000 response or provider error as a clean window', () => {
    expect(extractPullRows({ ResponseCode: '1000', Response: [[]] }).shape).toBe('unsupported');
    expect(extractPullRows({ Response: [] }).shape).toBe('unsupported');
    expect(extractPullRows({ ResponseCode: '400.001', Response: [] }).shape).toBe('provider_error');
  });

  test('rejects malformed nested response arrays instead of dropping invalid entries', () => {
    expect(extractPullRows({ ResponseCode: '1000', Response: [[{ transactionId: '1' }, null]] }))
      .toEqual({ shape: 'unsupported', rows: [] });
  });
});

describe('queryPullTransactions request contract', () => {
  test('uses POST with the documented body and Bearer token', async () => {
    const calls = [];
    const oauth = {
      baseURL: 'https://sandbox.safaricom.co.ke',
      getAccessToken: async () => 'test-token',
    };
    const http = {
      post: async (...args) => {
        calls.push(args);
        return { status: 200, data: { ResponseCode: '1001' } };
      },
    };

    const response = await queryPullTransactions(oauth, {
      shortCode: '600987',
      startDate: '2026-11-13 10:00:00',
      endDate: '2026-11-13 11:00:00',
      offSetValue: '0',
      http,
    });

    expect(response).toMatchObject({ httpStatus: 200, ok: true, body: { ResponseCode: '1001' } });
    expect(calls).toHaveLength(1);
    expect(calls[0][0]).toBe('https://sandbox.safaricom.co.ke/pulltransactions/v1/query');
    expect(calls[0][1]).toEqual({
      ShortCode: '600987',
      StartDate: '2026-11-13 10:00:00',
      EndDate: '2026-11-13 11:00:00',
      OffSetValue: '0',
    });
    expect(calls[0][2].headers.Authorization).toBe('Bearer test-token');
  });
});
