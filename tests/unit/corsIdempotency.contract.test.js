/**
 * CORS contract for the credentialed SPA client.
 *
 * The authenticated frontend sends Content-Type, X-CSRF-Token and
 * Idempotency-Key. Idempotency-Key must be allow-listed or every money-moving
 * mutation fails at the browser preflight. These tests use the REAL cors and
 * CSRF middleware (no mocks of either) on a minimal express app.
 */
import '../setup.js';

process.env.FRONTEND_URL = 'http://localhost:3000,https://app.example.test';

const { default: express } = await import('express');
const { default: cookieParser } = await import('cookie-parser');
const { default: request } = await import('supertest');
const { corsMiddleware, CORS_ALLOWED_HEADERS } = await import('../../src/config/security.js');
const { issueCsrfCookie, csrfProtection } = await import('../../src/middlewares/csrf.js');

const ALLOWED = 'http://localhost:3000';
const SECOND_ALLOWED = 'https://app.example.test';
const FOREIGN = 'https://evil.example.test';

function buildApp() {
  const app = express();
  app.use(corsMiddleware);
  app.use(express.json());
  app.use(cookieParser('test-cookie-secret'));
  app.use(issueCsrfCookie);
  app.use('/api/v1', csrfProtection);
  app.get('/api/v1/ping', (_req, res) => res.json({ ok: true }));
  app.post('/api/v1/deposits/:tenantId/pay', (req, res) => {
    res.json({ ok: true, idempotencyKey: req.headers['idempotency-key'] || null });
  });
  // Mirrors the real app: errors (e.g. a blocked origin) become a non-2xx.
  // eslint-disable-next-line no-unused-vars
  app.use((err, _req, res, _next) => res.status(500).json({ error: err.message }));
  return app;
}

function allowedHeaderList(res) {
  return String(res.headers['access-control-allow-headers'] || '')
    .split(',')
    .map((h) => h.trim().toLowerCase())
    .filter(Boolean);
}

describe('CORS allow-list', () => {
  test('exports Idempotency-Key alongside the existing headers', () => {
    expect(CORS_ALLOWED_HEADERS).toEqual(
      expect.arrayContaining(['Content-Type', 'X-CSRF-Token', 'Idempotency-Key'])
    );
  });

  test('preflight from a configured Origin with all client headers is allowed', async () => {
    const res = await request(buildApp())
      .options('/api/v1/deposits/abc/pay')
      .set('Origin', ALLOWED)
      .set('Access-Control-Request-Method', 'POST')
      .set('Access-Control-Request-Headers', 'content-type,x-csrf-token,idempotency-key');

    expect(res.status).toBe(204);
    expect(res.headers['access-control-allow-origin']).toBe(ALLOWED);
    expect(res.headers['access-control-allow-credentials']).toBe('true');
    expect(allowedHeaderList(res)).toEqual(
      expect.arrayContaining(['content-type', 'x-csrf-token', 'idempotency-key'])
    );
  });

  test('every configured Origin is accepted, never a wildcard', async () => {
    for (const origin of [ALLOWED, SECOND_ALLOWED]) {
      const res = await request(buildApp())
        .options('/api/v1/deposits/abc/pay')
        .set('Origin', origin)
        .set('Access-Control-Request-Method', 'POST')
        .set('Access-Control-Request-Headers', 'idempotency-key');
      expect(res.headers['access-control-allow-origin']).toBe(origin);
      expect(res.headers['access-control-allow-origin']).not.toBe('*');
    }
  });

  test('preflight from an unconfigured Origin is rejected', async () => {
    const res = await request(buildApp())
      .options('/api/v1/deposits/abc/pay')
      .set('Origin', FOREIGN)
      .set('Access-Control-Request-Method', 'POST')
      .set('Access-Control-Request-Headers', 'idempotency-key');
    expect(res.headers['access-control-allow-origin']).toBeUndefined();
    expect(res.status).toBeGreaterThanOrEqual(400);
  });

  test('a lookalike Origin (suffix/prefix of an allowed one) is rejected', async () => {
    const res = await request(buildApp())
      .options('/api/v1/deposits/abc/pay')
      .set('Origin', `${ALLOWED}.evil.test`)
      .set('Access-Control-Request-Method', 'POST');
    expect(res.headers['access-control-allow-origin']).toBeUndefined();
  });
});

describe('credentialed mutation with CSRF and Idempotency-Key', () => {
  async function primeCsrf(app) {
    const res = await request(app).get('/api/v1/ping').set('Origin', ALLOWED);
    const cookie = (res.headers['set-cookie'] || []).find((c) => c.startsWith('csrf-token='));
    const token = cookie.split(';')[0].split('=')[1];
    return { cookieHeader: `csrf-token=${token}`, token };
  }

  test('succeeds with cookie, matching CSRF header, Origin and Idempotency-Key', async () => {
    const app = buildApp();
    const { cookieHeader, token } = await primeCsrf(app);
    const res = await request(app)
      .post('/api/v1/deposits/abc/pay')
      .set('Origin', ALLOWED)
      .set('Cookie', cookieHeader)
      .set('X-CSRF-Token', token)
      .set('Idempotency-Key', 'key-123')
      .send({ amountCents: 100 });

    expect(res.status).toBe(200);
    expect(res.body.idempotencyKey).toBe('key-123');
    expect(res.headers['access-control-allow-credentials']).toBe('true');
  });

  test('a mutation with no CSRF cookie or header is still rejected', async () => {
    const res = await request(buildApp())
      .post('/api/v1/deposits/abc/pay')
      .set('Origin', ALLOWED)
      .set('Idempotency-Key', 'key-123')
      .send({});
    expect(res.status).toBe(403);
  });

  test('a mismatched CSRF header is still rejected', async () => {
    const app = buildApp();
    const { cookieHeader } = await primeCsrf(app);
    const res = await request(app)
      .post('/api/v1/deposits/abc/pay')
      .set('Origin', ALLOWED)
      .set('Cookie', cookieHeader)
      .set('X-CSRF-Token', 'not-the-cookie-value')
      .set('Idempotency-Key', 'key-123')
      .send({});
    expect(res.status).toBe(403);
  });

  test('a mutation from an unconfigured Origin is rejected even with a valid CSRF pair', async () => {
    const app = buildApp();
    const { cookieHeader, token } = await primeCsrf(app);
    const res = await request(app)
      .post('/api/v1/deposits/abc/pay')
      .set('Origin', FOREIGN)
      .set('Cookie', cookieHeader)
      .set('X-CSRF-Token', token)
      .set('Idempotency-Key', 'key-123')
      .send({});
    expect(res.status).toBeGreaterThanOrEqual(400);
    expect(res.headers['access-control-allow-origin']).toBeUndefined();
  });
});
