import { describe, test, expect } from '@jest/globals';
import { createDarajaOAuthClient } from '../../../src/services/mpesa/darajaOAuth.client.js';

function mockHttp(handler) {
  return {
    get: async (url, config) => handler({ method: 'get', url, config }),
    post: async (url, body, config) => handler({ method: 'post', url, body, config }),
  };
}

describe('Daraja OAuth client', () => {
  test('acquires and caches token', async () => {
    let calls = 0;
    const http = mockHttp(async () => {
      calls += 1;
      return {
        status: 200,
        data: { access_token: 'tok-1', expires_in: 3599 },
      };
    });
    const client = createDarajaOAuthClient({
      environment: 'sandbox',
      consumerKey: 'key',
      consumerSecret: 'secret',
      http,
    });
    const a = await client.getAccessToken();
    const b = await client.getAccessToken();
    expect(a).toBe('tok-1');
    expect(b).toBe('tok-1');
    expect(calls).toBe(1);
  });

  test('coalesces concurrent refresh', async () => {
    let calls = 0;
    const http = mockHttp(async () => {
      calls += 1;
      await new Promise((r) => setTimeout(r, 30));
      return { status: 200, data: { access_token: 'tok-2', expires_in: 3599 } };
    });
    const client = createDarajaOAuthClient({
      environment: 'sandbox',
      consumerKey: 'key',
      consumerSecret: 'secret',
      http,
    });
    const [a, b, c] = await Promise.all([
      client.getAccessToken(),
      client.getAccessToken(),
      client.getAccessToken(),
    ]);
    expect(a).toBe('tok-2');
    expect(b).toBe('tok-2');
    expect(c).toBe('tok-2');
    expect(calls).toBe(1);
  });

  test('invalid credentials surface failure without leaking secret', async () => {
    const http = mockHttp(async () => ({ status: 401, data: { error: 'invalid' } }));
    const client = createDarajaOAuthClient({
      environment: 'sandbox',
      consumerKey: 'key',
      consumerSecret: 'super-secret-value',
      http,
    });
    await expect(client.getAccessToken()).rejects.toMatchObject({ code: 'DARAJA_OAUTH_FAILED' });
    try {
      await client.getAccessToken();
    } catch (err) {
      expect(JSON.stringify(err)).not.toContain('super-secret-value');
    }
  });

  test('forceRefresh bypasses cache', async () => {
    let calls = 0;
    const http = mockHttp(async () => {
      calls += 1;
      return { status: 200, data: { access_token: `tok-${calls}`, expires_in: 3599 } };
    });
    const client = createDarajaOAuthClient({
      environment: 'sandbox',
      consumerKey: 'key',
      consumerSecret: 'secret',
      http,
    });
    await client.getAccessToken();
    const t2 = await client.getAccessToken({ forceRefresh: true });
    expect(t2).toBe('tok-2');
    expect(calls).toBe(2);
  });

  test('debugState never exposes token', async () => {
    const http = mockHttp(async () => ({
      status: 200,
      data: { access_token: 'secret-token', expires_in: 1000 },
    }));
    const client = createDarajaOAuthClient({
      environment: 'sandbox',
      consumerKey: 'key',
      consumerSecret: 'secret',
      http,
    });
    await client.getAccessToken();
    const snap = client.debugState();
    expect(snap.hasCachedToken).toBe(true);
    expect(JSON.stringify(snap)).not.toContain('secret-token');
  });
});
