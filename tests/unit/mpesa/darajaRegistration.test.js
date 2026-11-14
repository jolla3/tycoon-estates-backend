import { describe, test, expect } from '@jest/globals';
import { registerC2bUrls } from '../../../src/services/mpesa/darajaC2b.service.js';
import { registerPull } from '../../../src/services/mpesa/darajaPull.service.js';

const oauth = {
  baseURL: 'https://sandbox.safaricom.co.ke',
  getAccessToken: async () => 'test-access-token',
};

describe('Daraja registration request contracts', () => {
  test('C2B URL registration defaults to v2 and accepts the documented success code', async () => {
    const previous = process.env.DARAJA_C2B_REGISTER_PATH;
    delete process.env.DARAJA_C2B_REGISTER_PATH;
    const calls = [];
    try {
      const result = await registerC2bUrls(oauth, {
        shortCode: '600987',
        responseType: 'Completed',
        confirmationUrl: 'https://example.test/c2b/confirm',
        validationUrl: 'https://example.test/c2b/validate',
        http: {
          post: async (...args) => {
            calls.push(args);
            return {
              status: 200,
              data: { ResponseCode: '00000000', ResponseDescription: 'Success' },
            };
          },
        },
      });

      expect(calls).toHaveLength(1);
      expect(calls[0][0]).toBe('https://sandbox.safaricom.co.ke/mpesa/c2b/v2/registerurl');
      expect(calls[0][1]).toEqual({
        ShortCode: '600987',
        ResponseType: 'Completed',
        ConfirmationURL: 'https://example.test/c2b/confirm',
        ValidationURL: 'https://example.test/c2b/validate',
      });
      expect(calls[0][2].headers.Authorization).toBe('Bearer test-access-token');
      expect(result).toMatchObject({
        httpStatus: 200,
        responseCode: '00000000',
        ok: true,
        registrationState: 'ACCEPTED',
      });
    } finally {
      if (previous === undefined) delete process.env.DARAJA_C2B_REGISTER_PATH;
      else process.env.DARAJA_C2B_REGISTER_PATH = previous;
    }
  });

  test('C2B HTTP 200 with a non-success provider code is rejected', async () => {
    const previous = process.env.DARAJA_C2B_REGISTER_PATH;
    delete process.env.DARAJA_C2B_REGISTER_PATH;
    try {
      const result = await registerC2bUrls(oauth, {
        shortCode: '600987',
        confirmationUrl: 'https://example.test/confirm',
        validationUrl: 'https://example.test/validate',
        http: {
          post: async () => ({
            status: 200,
            data: { ResponseCode: '12345678', ResponseDescription: 'Rejected' },
          }),
        },
      });
      expect(result.ok).toBe(false);
      expect(result.registrationState).toBe('REJECTED');
    } finally {
      if (previous === undefined) delete process.env.DARAJA_C2B_REGISTER_PATH;
      else process.env.DARAJA_C2B_REGISTER_PATH = previous;
    }
  });

  test('Pull registration reads documented ResponseStatus 1000', async () => {
    const calls = [];
    const result = await registerPull(oauth, {
      shortCode: '600987',
      nominatedNumber: '254722000000',
      callBackUrl: 'https://example.test/pull/results',
      http: {
        post: async (...args) => {
          calls.push(args);
          return {
            status: 200,
            data: { ResponseStatus: '1000', ResponseDescription: 'Shortcode Registered Successfully' },
          };
        },
      },
    });

    expect(calls[0][0]).toBe('https://sandbox.safaricom.co.ke/pulltransactions/v1/register');
    expect(calls[0][1]).toEqual({
      ShortCode: '600987',
      RequestType: 'Pull',
      NominatedNumber: '254722000000',
      CallBackURL: 'https://example.test/pull/results',
    });
    expect(calls[0][2].headers.Authorization).toBe('Bearer test-access-token');
    expect(result).toMatchObject({
      responseCode: '1000',
      ok: true,
      registrationState: 'ACCEPTED',
    });
  });

  test('Pull registration recognizes ResponseStatus 1001 as already registered', async () => {
    const result = await registerPull(oauth, {
      shortCode: '600987',
      nominatedNumber: '254722000000',
      callBackUrl: 'https://example.test/pull/results',
      http: { post: async () => ({ status: 200, data: { ResponseStatus: '1001' } }) },
    });
    expect(result).toMatchObject({
      responseCode: '1001',
      alreadyRegistered: true,
      ok: true,
      registrationState: 'ALREADY_REGISTERED',
    });
  });

  test('C2B HTTP 200 without a provider response code is rejected', async () => {
    const previous = process.env.DARAJA_C2B_REGISTER_PATH;
    delete process.env.DARAJA_C2B_REGISTER_PATH;
    try {
      const result = await registerC2bUrls(oauth, {
        shortCode: '600987',
        confirmationUrl: 'https://example.test/confirm',
        validationUrl: 'https://example.test/validate',
        http: {
          post: async () => ({
            status: 200,
            data: { ResponseDescription: 'Success' },
          }),
        },
      });
      expect(result).toMatchObject({
        httpStatus: 200,
        responseCode: '',
        ok: false,
        registrationState: 'REJECTED',
      });
    } finally {
      if (previous === undefined) delete process.env.DARAJA_C2B_REGISTER_PATH;
      else process.env.DARAJA_C2B_REGISTER_PATH = previous;
    }
  });

  test('Pull HTTP 200 without ResponseStatus is rejected', async () => {
    const result = await registerPull(oauth, {
      shortCode: '600987',
      nominatedNumber: '254722000000',
      callBackUrl: 'https://example.test/pull/results',
      http: {
        post: async () => ({
          status: 200,
          data: { ResponseDescription: 'Success' },
        }),
      },
    });
    expect(result).toMatchObject({
      httpStatus: 200,
      responseCode: '',
      alreadyRegistered: false,
      ok: false,
      registrationState: 'REJECTED',
    });
  });

  test('Pull registration rejects undocumented ResponseCode aliases', async () => {
    const result = await registerPull(oauth, {
      shortCode: '600987',
      nominatedNumber: '254722000000',
      callBackUrl: 'https://example.test/pull/results',
      http: {
        post: async () => ({
          status: 200,
          data: { ResponseCode: '1000', ResponseDescription: 'Success' },
        }),
      },
    });

    expect(result).toMatchObject({
      responseCode: '',
      alreadyRegistered: false,
      ok: false,
      registrationState: 'REJECTED',
    });
  });

});
