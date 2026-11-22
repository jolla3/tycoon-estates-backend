import '../setup.js';
import {
  listOperationalBankProviders,
  assertProviderOperational,
  createBankProviderForConnection,
  getBankProviderCapabilities,
} from '../../src/services/banking/bank.factory.js';

describe('bank factory connection isolation', () => {
  test('COOP is implemented; no provider is operationalReady without live verification', () => {
    const ops = listOperationalBankProviders();
    expect(ops).toHaveLength(0);
    expect(getBankProviderCapabilities('COOP').implemented).toBe(true);
    expect(getBankProviderCapabilities('COOP').operationalReady).toBe(false);
  });

  test('assertProviderOperational rejects unimplemented identifiers', () => {
    expect(() => assertProviderOperational('KCB')).toThrow(/Unsupported bank provider/);
    expect(() => assertProviderOperational('EQUITY')).toThrow(/Unsupported bank provider/);
  });

  test('createBankProviderForConnection requires credential context object', () => {
    expect(() => createBankProviderForConnection('COOP', null)).toThrow();
  });

  test('two COOP adapters are distinct instances (no provider-name singleton)', () => {
    const a = createBankProviderForConnection('COOP', {
      consumerKey: 'a', consumerSecret: 'a',
    }, { connectionId: 'conn-a', credentialVersion: 1 });
    const b = createBankProviderForConnection('COOP', {
      consumerKey: 'b', consumerSecret: 'b',
    }, { connectionId: 'conn-b', credentialVersion: 2 });
    expect(a).not.toBe(b);
    expect(a.connectionId).toBe('conn-a');
    expect(b.credentialVersion).toBe(2);
  });

  test('capabilities remain explicit on the registry', () => {
    const caps = getBankProviderCapabilities('COOP');
    expect(caps.accountValidation).toBe(true);
    expect(getBankProviderCapabilities('NCBA').implemented).toBe(false);
  });

  test('tenant credential material cannot override the trusted COOP endpoint or webhook secret', () => {
    const untrustedBaseUrl = 'http://127.0.0.1:1/internal';
    const untrustedWebhookSecret = 'tenant-controlled-webhook-secret';

    const provider = createBankProviderForConnection(
      'COOP',
      {
        baseUrl: untrustedBaseUrl,
        insBasicSecret: untrustedWebhookSecret,
        consumerKey: 'tenant-ck',
        consumerSecret: 'tenant-sk',
        // legacy keys must be ignored, never mapped
        clientId: 'legacy-id',
        clientSecret: 'legacy-secret',
        username: 'legacy-user',
        password: 'legacy-pass',
        scope: 'legacy.scope',
      },
      {
        connectionId: 'connection-test',
        credentialVersion: 1,
      }
    );

    // Endpoint comes only from trusted process configuration.
    expect(provider.baseUrl).toBe(process.env.COOP_BASE_URL || undefined);
    expect(provider.baseUrl).not.toBe(untrustedBaseUrl);

    // The shared inbound webhook secret is not taken from tenant credentials.
    expect(provider.insBasicSecret).toBeUndefined();

    // Customer-specific OAuth credentials still reach the auth service.
    expect(provider.auth.consumerKey).toBe('tenant-ck');
    expect(provider.auth.consumerSecret).toBe('tenant-sk');
    for (const legacy of ['clientId', 'clientSecret', 'username', 'password', 'scope']) {
      expect(provider.auth[legacy]).toBeUndefined();
    }
  });
  test('COOP lab access requires the explicit flag and is rejected in production', () => {
    expect(() => assertProviderOperational('COOP', {
      allowLab: true,
      labMode: false,
      nodeEnv: 'test',
    })).toThrow(/not operationally ready/);

    expect(assertProviderOperational('COOP', {
      allowLab: true,
      labMode: true,
      nodeEnv: 'test',
    }).implemented).toBe(true);

    expect(() => assertProviderOperational('COOP', {
      allowLab: true,
      labMode: true,
      nodeEnv: 'production',
    })).toThrow(/not operationally ready/);
  });

});
