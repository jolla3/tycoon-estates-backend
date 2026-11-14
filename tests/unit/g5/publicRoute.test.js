import fs from 'fs';
import express from 'express';
import request from 'supertest';
import { jest } from '@jest/globals';
import { generateBearerToken } from '../../../src/utils/g5Token.js';

// Force the real middleware through its Redis-unavailable fallback.
// No network connection or Redis client is created by this unit test.
jest.unstable_mockModule('../../../src/config/redis.js', () => ({
  getRedisClient: jest.fn(() => {
    throw new Error('Redis intentionally unavailable in this unit test');
  }),
}));

const { default: mpesaPublicRoutes } = await import(
  '../../../src/routes/mpesaPublic.routes.js'
);

const app = express();
app.set('trust proxy', true);
app.use('/api/v1/public/mpesa', mpesaPublicRoutes);

const post = (body, ip = '198.51.100.10') =>
  request(app)
    .post('/api/v1/public/mpesa/submissions')
    .set('X-Forwarded-For', ip)
    .set('Content-Type', 'application/json')
    .send(body);

describe('public submission route', () => {
  beforeAll(() => {
    delete process.env.G5_SUBMISSIONS_ENABLED;
  });

  test('sets no-store, no-referrer and restrictive CSP', async () => {
    const r = await post({ token: generateBearerToken(), text: 'x' });
    expect(r.headers['cache-control']).toBe('no-store');
    expect(r.headers['referrer-policy']).toBe('no-referrer');
    expect(r.headers['content-security-policy']).toMatch(/default-src 'none'/);
    expect(r.headers['set-cookie']).toBeUndefined();
  });

  test('feature off, unknown, and malformed tokens are indistinguishable', async () => {
    const a = await post({ token: generateBearerToken(), text: 'x' });
    const b = await post({ token: 'bad', text: 'x' });
    const c = await post({ text: 'x' });

    for (const r of [a, b, c]) expect(r.status).toBe(404);
    expect(a.body).toEqual(b.body);
    expect(b.body).toEqual(c.body);
  });

  test('rejects unknown fields and oversize bodies without echoing input', async () => {
    const u = await post({ token: 'x', text: 'y', tenantId: 'abc' });
    expect(u.status).toBe(400);

    const big = await post({ token: 'x', text: 'y'.repeat(10000) });
    expect(big.status).toBe(413);
    expect(JSON.stringify(big.body)).not.toContain('yyyy');
  });

  test('app mounts public route before the global JSON parser and CSRF boundary', () => {
    const src = fs.readFileSync(
      new URL('../../../src/app.js', import.meta.url),
      'utf8'
    );
    const pub = src.indexOf("app.use('/api/v1/public/mpesa'");
    expect(pub).toBeGreaterThan(0);
    expect(pub).toBeLessThan(src.indexOf('app.use(express.json('));
    expect(pub).toBeLessThan(src.indexOf('csrfProtection, apiRoutes'));
  });

  test('abuse limiter enforces the per-IP limit using local fallback', async () => {
    const abuseIp = '198.51.100.77';
    const codes = [];

    for (let i = 0; i < 21; i += 1) {
      codes.push(
        (await post({ token: generateBearerToken(), text: 'x' }, abuseIp)).status
      );
    }

    expect(codes.slice(0, 20)).not.toContain(429);
    expect(codes[20]).toBe(429);
  }, 30000);
});
