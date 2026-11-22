import { sealLinkToken, openLinkToken } from '../../src/utils/g5LinkTokenEnvelope.js';

describe('G5 reusable link token envelope', () => {
  const context = {
    linkId: '64a000000000000000000001',
    clientId: '64a000000000000000000002',
    estateId: '64a000000000000000000003',
    tenantId: '64a000000000000000000004',
    linkVersion: 7,
  };
  const token = 'a'.repeat(43);
  const key = (byte) => byte.repeat(64);

  beforeEach(() => {
    process.env.G5_ENVELOPE_KEYS = 'k2:' + key('2') + ',k1:' + key('1');
  });

  test('round-trips a bearer token and binds it to link owner and version', () => {
    const envelope = sealLinkToken(token, context);
    expect(openLinkToken(envelope, context)).toBe(token);
    expect(() => openLinkToken(envelope, { ...context, estateId: '64a000000000000000000099' })).toThrow(/authentication failed/i);
    expect(() => openLinkToken(envelope, { ...context, linkVersion: 8 })).toThrow(/authentication failed/i);
  });

  test('retains decryption with a previous key after keyring rotation', () => {
    const envelope = sealLinkToken(token, context);
    process.env.G5_ENVELOPE_KEYS = 'k3:' + key('3') + ',k2:' + key('2') + ',k1:' + key('1');
    expect(openLinkToken(envelope, context)).toBe(token);
  });

  test('fails closed when the envelope is corrupted or its key is unavailable', () => {
    const envelope = sealLinkToken(token, context);
    const parts = envelope.split('.');
    parts[3] = (parts[3][0] === 'A' ? 'B' : 'A') + parts[3].slice(1);
    expect(() => openLinkToken(parts.join('.'), context)).toThrow();
    process.env.G5_ENVELOPE_KEYS = 'k3:' + key('3');
    expect(() => openLinkToken(envelope, context)).toThrow(/unavailable/i);
  });
});
