import '../setup.js';
import { jest } from '@jest/globals';

const axiosPost = jest.fn();
jest.unstable_mockModule('axios', () => ({
  default: { post: axiosPost },
}));

const { CoopAuthService, invalidateCoopTokenCache } = await import(
  '../../src/services/banking/providers/coop/coop.auth.js'
);

describe('CoopAuthService client_credentials', () => {
  beforeEach(() => {
    axiosPost.mockReset();
    invalidateCoopTokenCache('conn-1');
    invalidateCoopTokenCache('conn-2');
  });

  test('sends Basic CK:SK and form-urlencoded client_credentials grant', async () => {
    axiosPost.mockResolvedValue({
      status: 200,
      data: { access_token: 'tok-1', token_type: 'Bearer', expires_in: 1200 },
    });

    const auth = new CoopAuthService({
      tokenUrl: 'https://example.test/token',
      consumerKey: 'ck-value',
      consumerSecret: 'sk-value',
      connectionId: 'conn-1',
      credentialVersion: 1,
    });

    expect(await auth.getAccessToken()).toBe('tok-1');
    const [url, body, opts] = axiosPost.mock.calls[0];
    expect(url).toBe('https://example.test/token');
    expect(body).toBe('grant_type=client_credentials');
    expect(opts.headers['Content-Type']).toBe('application/x-www-form-urlencoded');
    expect(opts.headers.Authorization).toBe(
      `Basic ${Buffer.from('ck-value:sk-value').toString('base64')}`
    );
  });

  test('does not invent expires_in when provider omits it', async () => {
    axiosPost.mockResolvedValue({
      status: 200,
      data: { access_token: 'tok-2', token_type: 'Bearer' },
    });
    const auth = new CoopAuthService({
      tokenUrl: 'https://example.test/token',
      consumerKey: 'ck',
      consumerSecret: 'sk',
      connectionId: 'conn-1',
      credentialVersion: 1,
    });
    await expect(auth.getAccessToken()).rejects.toThrow(/authenticate|expires_in/);
  });

  test('isolates tokens by connection', async () => {
    axiosPost
      .mockResolvedValueOnce({
        status: 200,
        data: { access_token: 'tok-a', token_type: 'Bearer', expires_in: 3600 },
      })
      .mockResolvedValueOnce({
        status: 200,
        data: { access_token: 'tok-b', token_type: 'Bearer', expires_in: 3600 },
      });
    const a = new CoopAuthService({
      tokenUrl: 'https://example.test/token',
      consumerKey: 'ck',
      consumerSecret: 'sk',
      connectionId: 'conn-1',
      credentialVersion: 1,
    });
    const b = new CoopAuthService({
      tokenUrl: 'https://example.test/token',
      consumerKey: 'ck',
      consumerSecret: 'sk',
      connectionId: 'conn-2',
      credentialVersion: 1,
    });
    expect(await a.getAccessToken()).toBe('tok-a');
    expect(await b.getAccessToken()).toBe('tok-b');
    expect(axiosPost).toHaveBeenCalledTimes(2);
    expect(await a.getAccessToken()).toBe('tok-a');
    expect(axiosPost).toHaveBeenCalledTimes(2);
  });

  test('single-flight concurrent acquisition', async () => {
    let resolvePost;
    axiosPost.mockImplementation(
      () => new Promise((resolve) => { resolvePost = resolve; })
    );
    const auth = new CoopAuthService({
      tokenUrl: 'https://example.test/token',
      consumerKey: 'ck',
      consumerSecret: 'sk',
      connectionId: 'conn-1',
      credentialVersion: 3,
    });
    const p1 = auth.getAccessToken();
    const p2 = auth.getAccessToken();
    resolvePost({
      status: 200,
      data: { access_token: 'shared', token_type: 'Bearer', expires_in: 900 },
    });
    const [t1, t2] = await Promise.all([p1, p2]);
    expect(t1).toBe('shared');
    expect(t2).toBe('shared');
    expect(axiosPost).toHaveBeenCalledTimes(1);
  });
});
