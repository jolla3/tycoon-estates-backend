import fs from 'fs';
import express from 'express';
import request from 'supertest';
import mpesaPublicRoutes from '../../../src/routes/mpesaPublic.routes.js';
import { generateBearerToken } from '../../../src/utils/g5Token.js';

const app = express();
app.use('/api/v1/public/mpesa', mpesaPublicRoutes);
const post = (body) => request(app).post('/api/v1/public/mpesa/submissions').set('Content-Type', 'application/json').send(body);

describe('public submission route', () => {
  beforeAll(() => { delete process.env.G5_SUBMISSIONS_ENABLED; });

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
    const src = fs.readFileSync(new URL('../../../src/app.js', import.meta.url), 'utf8');
    const pub = src.indexOf("app.use('/api/v1/public/mpesa'");
    expect(pub).toBeGreaterThan(0);
    expect(pub).toBeLessThan(src.indexOf("app.use(express.json("));
    expect(pub).toBeLessThan(src.indexOf('csrfProtection, apiRoutes'));
  });
  test('abuse limiter engages (fails closed to local counter when Redis is unreachable)', async () => {
    const codes = [];
    for (let i = 0; i < 18; i += 1) codes.push((await post({ token: generateBearerToken(), text: 'x' })).status);
    expect(codes).toContain(429);
  }, 30000);
});
