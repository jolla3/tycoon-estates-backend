/**
 * Co-op credential contract: CK/SK only, fail-closed on unverified token
 * contract, no secret leakage. Provider calls are MOCKED (axios) — this is
 * contract-shape coverage, NOT sandbox verification.
 */
import '../setup.js';
import { jest } from '@jest/globals';

const post = jest.fn();
const logged = [];
jest.unstable_mockModule('axios', () => ({ default: { post } }));
jest.unstable_mockModule('../../src/config/logger.js', () => ({
  logger: { info: (...a) => logged.push(a), error: (...a) => logged.push(a), warn: (...a) => logged.push(a), debug: (...a) => logged.push(a) },
}));

const { CoopAuthService } = await import('../../src/services/banking/providers/coop/coop.auth.js');
const { schemas } = await import('../../src/utils/validators.js');

const cfg = { path: '/token', grantType: 'client_credentials', scope: null };
const svc = (over = {}) => new CoopAuthService({
  baseUrl: 'https://coop.example.test', consumerKey: 'CK-123', consumerSecret: 'SK-SECRET-456', tokenConfig: cfg, ...over,
});

beforeEach(() => { post.mockReset(); logged.length = 0; });

describe('CoopAuthService', () => {
  test('uses CK/SK as Basic auth with the configured grant; no username/password/scope sent', async () => {
    post.mockResolvedValue({ data: { access_token: 'tok', expires_in: 600 } });
    await expect(svc().getAccessToken()).resolves.toBe('tok');
    const [url, body, opts] = post.mock.calls[0];
    expect(url).toBe('https://coop.example.test/token');
    expect(body).toBe('grant_type=client_credentials');
    expect(opts.headers.Authorization).toBe(`Basic ${Buffer.from('CK-123:SK-SECRET-456').toString('base64')}`);
    expect(body).not.toMatch(/username|password|scope/);
  });

  test('fails closed with NO network call when the token contract is not configured', async () => {
    for (const tokenConfig of [{ path: null, grantType: 'x' }, { path: '/t', grantType: null }, {}]) {
      await expect(svc({ tokenConfig }).getAccessToken()).rejects.toMatchObject({ code: 'BANK_AUTH_FAILED' });
    }
    expect(post).not.toHaveBeenCalled();
  });

  test('missing CK or SK fails closed with no network call', async () => {
    await expect(svc({ consumerKey: '' }).getAccessToken()).rejects.toMatchObject({ code: 'BANK_AUTH_FAILED' });
    await expect(svc({ consumerSecret: undefined }).getAccessToken()).rejects.toMatchObject({ code: 'BANK_AUTH_FAILED' });
    expect(post).not.toHaveBeenCalled();
  });

  test('legacy fields passed to the constructor are ignored', () => {
    const s = new CoopAuthService({ baseUrl: 'x', clientId: 'a', clientSecret: 'b', username: 'c', password: 'd', scope: 'e', tokenConfig: cfg });
    for (const k of ['clientId', 'clientSecret', 'username', 'password', 'scope']) expect(s[k]).toBeUndefined();
  });

  test('platform scope, when configured, is sent; never tenant supplied', async () => {
    post.mockResolvedValue({ data: { access_token: 't', expires_in: 100 } });
    await svc({ tokenConfig: { ...cfg, scope: 'platform.scope' } }).getAccessToken();
    expect(post.mock.calls[0][1]).toBe('grant_type=client_credentials&scope=platform.scope');
  });

  test('token cached only for provider-stated expires_in; no invented TTL', async () => {
    post.mockResolvedValue({ data: { access_token: 'a1', expires_in: 3600 } });
    const s = svc();
    await s.getAccessToken(); await s.getAccessToken();
    expect(post).toHaveBeenCalledTimes(1);

    post.mockReset();
    post.mockResolvedValue({ data: { access_token: 'a2' } }); // no expires_in
    const s2 = svc();
    await s2.getAccessToken(); await s2.getAccessToken();
    expect(post).toHaveBeenCalledTimes(2);
  });

  test('concurrent callers share a single token request', async () => {
    post.mockResolvedValue({ data: { access_token: 'sf', expires_in: 600 } });
    const s = svc();
    const r = await Promise.all([s.getAccessToken(), s.getAccessToken(), s.getAccessToken()]);
    expect(r).toEqual(['sf', 'sf', 'sf']);
    expect(post).toHaveBeenCalledTimes(1);
  });

  test('tokens are isolated per instance', async () => {
    post.mockResolvedValueOnce({ data: { access_token: 'one', expires_in: 600 } })
      .mockResolvedValueOnce({ data: { access_token: 'two', expires_in: 600 } });
    expect(await svc().getAccessToken()).toBe('one');
    expect(await svc().getAccessToken()).toBe('two');
  });

  test('failure is generic and leaks neither secrets nor response bodies into error or logs', async () => {
    const err = Object.assign(new Error('boom SK-SECRET-456'), {
      response: { status: 401, data: { error: 'bad', echoed: 'SK-SECRET-456' } },
      config: { headers: { Authorization: 'Basic Q0stMTIzOlNLLVNFQ1JFVC00NTY=' } },
    });
    post.mockRejectedValue(err);
    const e = await svc().getAccessToken().catch((x) => x);
    expect(e.code).toBe('BANK_AUTH_FAILED');
    const dump = JSON.stringify([e.message, e.details, logged]);
    expect(dump).not.toMatch(/SK-SECRET-456|CK-123|Q0stMTIz/);
  });

  test('missing access_token in response is a failure', async () => {
    post.mockResolvedValue({ data: {} });
    await expect(svc().getAccessToken()).rejects.toMatchObject({ code: 'BANK_AUTH_FAILED' });
  });
});

describe('connection request schemas (CK/SK only, unknown fields rejected)', () => {
  const ok = { provider: 'COOP', credentialMaterial: { consumerKey: 'k', consumerSecret: 's' } };
  test.each(['createBankConnection', 'reauthorizeBankConnection'])('%s accepts CK/SK', (name) => {
    const body = name === 'createBankConnection' ? ok : { credentialMaterial: ok.credentialMaterial };
    expect(schemas[name].safeParse(body).success).toBe(true);
  });
  test.each(['createBankConnection', 'reauthorizeBankConnection'])('%s rejects legacy and unknown credential fields', (name) => {
    for (const extra of [{ clientId: 'x' }, { clientSecret: 'x' }, { username: 'x' }, { password: 'x' }, { scope: 'x' }, { pin: '1' }, { otp: '1' }]) {
      const cm = { ...ok.credentialMaterial, ...extra };
      const body = name === 'createBankConnection' ? { ...ok, credentialMaterial: cm } : { credentialMaterial: cm };
      expect(schemas[name].safeParse(body).success).toBe(false);
    }
  });
  test('rejects top-level unknown fields (e.g. scope next to credentialMaterial) and missing SK', () => {
    expect(schemas.createBankConnection.safeParse({ ...ok, scope: 'x' }).success).toBe(false);
    expect(schemas.createBankConnection.safeParse({ provider: 'COOP', credentialMaterial: { consumerKey: 'k' } }).success).toBe(false);
  });
});
