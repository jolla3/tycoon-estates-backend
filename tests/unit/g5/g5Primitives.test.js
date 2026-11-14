import { jest } from '@jest/globals';
import { generateBearerToken, isWellFormedToken, digestToken, digestsEqual } from '../../../src/utils/g5Token.js';
import { sealEnvelope, openEnvelope, envelopeKeyId, evidenceDigest } from '../../../src/utils/g5Envelope.js';

const K0 = 'a1'.repeat(32);
const K1 = 'b2'.repeat(32);
beforeEach(() => {
  process.env.G5_LINK_TOKEN_PEPPER = 'c3'.repeat(32);
  process.env.G5_EVIDENCE_DIGEST_KEY = 'd4'.repeat(32);
  process.env.G5_ENVELOPE_KEYS = `k1:${K1},k0:${K0}`;
});

describe('g5Token', () => {
  test('256-bit base64url token, well-formed, unique', () => {
    const a = generateBearerToken();
    expect(a).toHaveLength(43);
    expect(isWellFormedToken(a)).toBe(true);
    expect(generateBearerToken()).not.toBe(a);
  });
  test('rejects malformed tokens', () => {
    for (const t of ['', 'short', 'a'.repeat(44), `${'a'.repeat(42)}!`, null, 42]) expect(isWellFormedToken(t)).toBe(false);
    expect(() => digestToken('nope')).toThrow();
  });
  test('digest is keyed, deterministic, never the token', () => {
    const t = generateBearerToken();
    const d = digestToken(t);
    expect(d).toMatch(/^[0-9a-f]{64}$/);
    expect(d).toBe(digestToken(t));
    expect(d).not.toContain(t);
    process.env.G5_LINK_TOKEN_PEPPER = 'e5'.repeat(32);
    expect(digestToken(t)).not.toBe(d);
  });
  test('missing pepper fails closed', () => {
    delete process.env.G5_LINK_TOKEN_PEPPER;
    expect(() => digestToken(generateBearerToken())).toThrow(/PEPPER/);
  });
  test('digestsEqual constant-time semantics', () => {
    const d = digestToken(generateBearerToken());
    expect(digestsEqual(d, d)).toBe(true);
    expect(digestsEqual(d, digestToken(generateBearerToken()))).toBe(false);
    expect(digestsEqual(d, 'zz')).toBe(false);
    expect(digestsEqual(null, d)).toBe(false);
  });
});

describe('g5Envelope', () => {
  test('round trip with AAD, active key id first', () => {
    const e = sealEnvelope('hello +254', 'row:1');
    expect(e.startsWith('g5e1.k1.')).toBe(true);
    expect(envelopeKeyId(e)).toBe('k1');
    expect(e).not.toContain('hello');
    expect(openEnvelope(e, 'row:1')).toBe('hello +254');
  });
  test('wrong AAD, tamper, and unknown key are rejected', () => {
    const e = sealEnvelope('secret', 'row:1');
    expect(() => openEnvelope(e, 'row:2')).toThrow(/authentication/);
    const parts = e.split('.');
    parts[4] = Buffer.from('xxxxxx').toString('base64url');
    expect(() => openEnvelope(parts.join('.'), 'row:1')).toThrow();
    process.env.G5_ENVELOPE_KEYS = `k9:${K1}`;
    expect(() => openEnvelope(e, 'row:1')).toThrow(/key id unknown/);
  });
  test('rotation: old key still decrypts, new writes use the new key', () => {
    process.env.G5_ENVELOPE_KEYS = `k0:${K0}`;
    const old = sealEnvelope('v', 'a');
    process.env.G5_ENVELOPE_KEYS = `k1:${K1},k0:${K0}`;
    expect(openEnvelope(old, 'a')).toBe('v');
    expect(envelopeKeyId(sealEnvelope('v', 'a'))).toBe('k1');
  });
  test('AAD required; missing/invalid keys fail closed; IVs unique', () => {
    expect(() => sealEnvelope('x', '')).toThrow(/AAD/);
    expect(sealEnvelope('x', 'a')).not.toBe(sealEnvelope('x', 'a'));
    process.env.G5_ENVELOPE_KEYS = 'k1:short';
    expect(() => sealEnvelope('x', 'a')).toThrow();
    delete process.env.G5_ENVELOPE_KEYS;
    expect(() => sealEnvelope('x', 'a')).toThrow(/not configured/);
  });
  test('evidenceDigest keyed + deterministic + separate key', () => {
    const d = evidenceDigest('abc');
    expect(d).toBe(evidenceDigest('abc'));
    process.env.G5_EVIDENCE_DIGEST_KEY = 'f6'.repeat(32);
    expect(evidenceDigest('abc')).not.toBe(d);
  });
});
