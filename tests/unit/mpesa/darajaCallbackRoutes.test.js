// G5.3 — the three Daraja callback routes must stay closed regardless of env flags,
// and blocked requests must never reach a handler. Uses the REAL mounted router.
import { jest } from '@jest/globals';
import express from 'express';
import request from 'supertest';

const handlers = {
  confirm: jest.fn(async () => ({ httpStatus: 200, ack: { ResultCode: 0 } })),
  validate: jest.fn(async () => ({ ResultCode: 0, ResultDesc: 'Accepted' })),
  pull: jest.fn(async () => ({ allPersisted: true })),
};
const limiterHits = jest.fn();

jest.unstable_mockModule('../../../src/services/mpesa/darajaC2b.service.js', () => ({
  handleC2bConfirmation: handlers.confirm,
  handleC2bValidation: handlers.validate,
}));
jest.unstable_mockModule('../../../src/services/mpesa/darajaPull.service.js', () => ({
  ingestPullPayload: handlers.pull,
}));
jest.unstable_mockModule('../../../src/middlewares/rateLimiter.js', () => ({
  webhookRateLimiter: (req, res, next) => { limiterHits(); next(); },
}));

const { default: router } = await import('../../../src/routes/darajaWebhook.routes.js');
const { createDarajaIngressGate, getProviderCallbackVerifier, NOT_EXPOSED_BODY } =
  await import('../../../src/services/mpesa/darajaCallbackAuth.js');

const PATHS = ['/daraja/c2b/confirm', '/daraja/c2b/validate', '/daraja/pull/results'];
const app = express();
app.use(express.json());
app.use('/api/v1/webhooks', router);

const saved = { ...process.env };
beforeEach(() => {
  Object.values(handlers).forEach((h) => h.mockClear());
  limiterHits.mockClear();
});
afterEach(() => { process.env = { ...saved }; });

async function expectClosed() {
  for (const p of PATHS) {
    const res = await request(app).post(`/api/v1/webhooks${p}`).send({ TransID: 'X1' });
    expect(res.status).toBe(503);
    expect(res.body).toEqual(NOT_EXPOSED_BODY);
  }
  expect(handlers.confirm).not.toHaveBeenCalled();
  expect(handlers.validate).not.toHaveBeenCalled(); // validation must not auto-accept
  expect(handlers.pull).not.toHaveBeenCalled();
  expect(limiterHits).not.toHaveBeenCalled(); // gate precedes limiter
}

describe('Daraja callback routes', () => {
  test('default posture is closed', async () => { await expectClosed(); });

  test('DARAJA_CALLBACKS_ENABLED=1 does not open routes (production)', async () => {
    process.env.NODE_ENV = 'production';
    process.env.DARAJA_CALLBACKS_ENABLED = '1';
    await expectClosed();
  });

  test('DARAJA_CALLBACKS_LAB=1 does not open routes (non-production)', async () => {
    process.env.NODE_ENV = 'development';
    process.env.DARAJA_CALLBACKS_LAB = '1';
    process.env.DARAJA_CALLBACKS_ENABLED = '1';
    await expectClosed();
  });

  test('no verifier is registered', () => {
    expect(getProviderCallbackVerifier()).toBeNull();
  });

  test('forged headers/auth do not open routes', async () => {
    for (const p of PATHS) {
      const res = await request(app).post(`/api/v1/webhooks${p}`)
        .set('Authorization', 'Basic Zm9vOmJhcg==').set('X-Forwarded-For', '196.201.214.200')
        .send({});
      expect(res.status).toBe(503);
    }
    expect(handlers.confirm).not.toHaveBeenCalled();
  });

  test('gate opens only for a verifier whose verify() resolves true', async () => {
    const mk = (v) => {
      const a = express();
      a.post('/t', createDarajaIngressGate(() => v), (req, res) => res.json({ ok: true }));
      return a;
    };
    expect((await request(mk(null)).post('/t')).status).toBe(503);
    expect((await request(mk({})).post('/t')).status).toBe(503);
    expect((await request(mk({ verify: () => 'yes' })).post('/t')).status).toBe(503);
    expect((await request(mk({ verify: () => { throw new Error('x'); } })).post('/t')).status).toBe(503);
    expect((await request(mk({ verify: async () => true })).post('/t')).status).toBe(200);
  });
});
