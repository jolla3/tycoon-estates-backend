// Logic-level lifecycle tests with an in-memory profile store and injected OAuth/http fakes.
// No live provider call is made. Atomic-claim semantics are emulated; real MongoDB atomicity is
// covered by tests/integration/g54.sharedPaybill.test.js (NOT EXECUTED in this environment).
import '../../setup.js';
import { jest } from '@jest/globals';

let profile;
const audits = [];
const auditRequired = jest.fn(async (e) => { audits.push(e); });
const updates = [];

const stateMatches = (cur, cond) => {
  if (cond === undefined) return true;
  if (cond && typeof cond === 'object') {
    if (cond.$nin) return !cond.$nin.includes(cur);
    if (cond.$in) return cond.$in.includes(cur);
  }
  return cur === cond;
};
const applySet = (set) => { for (const [k, v] of Object.entries(set)) profile[k] = v; };

jest.unstable_mockModule('../../../src/models/MpesaMerchantProfile.js', () => ({
  MpesaMerchantProfile: {
    findOne: () => ({ select: async () => (profile ? { ...profile } : null) }),
    updateOne: async (filter, upd) => {
      updates.push({ filter, set: upd.$set });
      for (const f of ['c2bRegistrationState', 'pullRegistrationState']) {
        if (f in filter && !stateMatches(profile[f], filter[f])) return { modifiedCount: 0 };
      }
      applySet(upd.$set);
      return { modifiedCount: 1 };
    },
    findOneAndUpdate: async () => null,
  },
}));
jest.unstable_mockModule('../../../src/services/audit.service.js', () => ({ auditRequired }));
jest.unstable_mockModule('../../../src/services/mpesa/darajaCallbackConfig.service.js', () => ({
  getCallbackConfig: () => ({
    configured: true, environment: 'sandbox', configId: 'daraja-sandbox', version: 'abc123abc123',
    confirmationUrl: 'https://x.test/c', validationUrl: 'https://x.test/v', pullResultsUrl: 'https://x.test/p',
  }),
}));
jest.unstable_mockModule('../../../src/utils/encryption.js', () => ({
  encryptionUtil: { decrypt: () => '254712345678', encrypt: (v) => `enc:${v}` },
}));

const { mpesaRegistrationService } = await import('../../../src/services/mpesa/mpesaRegistration.service.js');

const oauthOk = { baseURL: 'https://sandbox.example', getAccessToken: async () => 'tok' };
const oauthBad = { baseURL: 'https://sandbox.example', getAccessToken: async () => { throw new Error('401 bad creds'); } };
const verified = { PAYBILL: { verified: true, evidence: 'sandbox-observation-test' }, BUY_GOODS_TILL: { verified: true, evidence: 'x' } };
const base = { clientId: 'c1', profileId: 'p1', actor: { _id: 'u1' } };
const actions = () => audits.map((a) => a.action);
const reqStates = (f) => updates.filter((u) => u.set?.[f] === 'REQUESTED');

const resp = (status, data) => ({ post: jest.fn(async () => ({ status, data })) });
const c2bOk = () => resp(200, { ResponseCode: '00000000' });
const pullOk = () => resp(200, { ResponseStatus: '1000' });

beforeEach(() => {
  audits.length = 0; updates.length = 0; auditRequired.mockClear();
  auditRequired.mockImplementation(async (e) => { audits.push(e); });
  profile = {
    _id: 'p1', clientId: 'c1', merchantType: 'BUY_GOODS_TILL', businessShortCode: '600987',
    c2bRegistrationState: 'NONE', pullRegistrationState: 'NONE', pullNominatedMsisdnEncrypted: 'enc:254712345678',
    operationalState: 'DRAFT', pullCapability: 'UNKNOWN',
  };
});

describe('Pull registration fails closed on unverified merchant-type eligibility', () => {
  test('default eligibility (nothing verified) sends nothing, touches nothing, needs no credentials', async () => {
    const http = pullOk();
    await expect(mpesaRegistrationService.registerPull({ ...base, http, oauthClient: oauthOk }))
      .rejects.toMatchObject({ code: 'MPESA_PULL_ELIGIBILITY_UNVERIFIED', status: 409 });
    expect(http.post).not.toHaveBeenCalled();
    expect(updates).toHaveLength(0);
    expect(audits).toHaveLength(0);
    expect(profile.pullRegistrationState).toBe('NONE');
  });
  test('holds for PAYBILL as well', async () => {
    profile.merchantType = 'PAYBILL';
    await expect(mpesaRegistrationService.registerPull({ ...base, http: pullOk(), oauthClient: oauthOk })).rejects.toMatchObject({ status: 409 });
  });
});

describe('token acquisition failure is a pre-send failure, never a stale REQUESTED', () => {
  test('C2B: no claim, no request, state unchanged, NOT_SENT audited', async () => {
    const http = c2bOk();
    await expect(mpesaRegistrationService.registerC2b({ ...base, http, oauthClient: oauthBad })).rejects.toMatchObject({ status: 503 });
    expect(http.post).not.toHaveBeenCalled();
    expect(reqStates('c2bRegistrationState')).toHaveLength(0);
    expect(profile.c2bRegistrationState).toBe('NONE');
    expect(actions()).toEqual(['MPESA_C2B_REGISTRATION_NOT_SENT']);
  });
  test('Pull (when eligibility is verified): same', async () => {
    const http = pullOk();
    await expect(mpesaRegistrationService.registerPull({ ...base, http, oauthClient: oauthBad, eligibility: verified })).rejects.toMatchObject({ status: 503 });
    expect(http.post).not.toHaveBeenCalled();
    expect(profile.pullRegistrationState).toBe('NONE');
    expect(actions()).toEqual(['MPESA_PULL_REGISTRATION_NOT_SENT']);
  });
});

describe('outcomes after a request is sent', () => {
  test('network timeout stays UNCERTAIN, with sending + attempted audit evidence', async () => {
    const http = { post: jest.fn(async () => { throw new Error('ETIMEDOUT'); }) };
    const out = await mpesaRegistrationService.registerC2b({ ...base, http, oauthClient: oauthOk });
    expect(out.registrationState).toBe('UNCERTAIN');
    expect(profile.c2bRegistrationState).toBe('UNCERTAIN');
    expect(actions()).toEqual(['MPESA_C2B_REGISTRATION_SENDING', 'MPESA_C2B_REGISTRATION_ATTEMPTED']);
    expect(profile['c2bRegistration.succeededAt']).toBeUndefined();
  });
  test('the sending audit is written BEFORE the provider request', async () => {
    let auditedBeforeSend = false;
    const http = { post: jest.fn(async () => { auditedBeforeSend = actions().includes('MPESA_C2B_REGISTRATION_SENDING'); return { status: 200, data: { ResponseCode: '00000000' } }; }) };
    await mpesaRegistrationService.registerC2b({ ...base, http, oauthClient: oauthOk });
    expect(auditedBeforeSend).toBe(true);
  });
  test('provider rejection (4xx / non-success code) is REJECTED and retryable only for C2B/Pull REJECTED', async () => {
    const out = await mpesaRegistrationService.registerC2b({ ...base, http: resp(400, { errorMessage: 'bad' }), oauthClient: oauthOk });
    expect(out.registrationState).toBe('REJECTED');
    expect(profile.c2bRegistrationState).toBe('REJECTED');
  });
  test('5xx after submission is UNCERTAIN, not REJECTED', async () => {
    const out = await mpesaRegistrationService.registerC2b({ ...base, http: resp(503, {}), oauthClient: oauthOk });
    expect(out.registrationState).toBe('UNCERTAIN');
  });
  test('accepted response records evidence only; nothing becomes operational', async () => {
    const out = await mpesaRegistrationService.registerC2b({ ...base, http: c2bOk(), oauthClient: oauthOk });
    expect(out.registrationState).toBe('ACCEPTED');
    expect(profile['c2bRegistration.succeededAt']).toBeInstanceOf(Date);
    expect(profile.operationalState).toBe('DRAFT');
    expect(profile.pullCapability).toBe('UNKNOWN');
    for (const u of updates) {
      expect(Object.keys(u.set)).not.toEqual(expect.arrayContaining(['operationalState']));
      expect(Object.keys(u.set)).not.toEqual(expect.arrayContaining(['pullCapability']));
    }
  });
  test('Pull accepted (eligibility verified) records evidence only and never leaks the number', async () => {
    const out = await mpesaRegistrationService.registerPull({ ...base, http: pullOk(), oauthClient: oauthOk, eligibility: verified });
    expect(out.registrationState).toBe('ACCEPTED');
    expect(profile.pullCapability).toBe('UNKNOWN');
    expect(JSON.stringify(audits)).not.toContain('254712345678');
    expect(JSON.stringify(out)).not.toContain('254712345678');
    expect(JSON.stringify(updates)).not.toContain('254712345678');
  });
});

describe('UNCERTAIN / REQUESTED require reconciliation before retry', () => {
  test.each(['REQUESTED', 'UNCERTAIN'])('C2B %s blocks a new attempt before any credential use', async (st) => {
    profile.c2bRegistrationState = st;
    const http = c2bOk(); const oauth = { baseURL: 'x', getAccessToken: jest.fn(async () => 't') };
    await expect(mpesaRegistrationService.registerC2b({ ...base, http, oauthClient: oauth })).rejects.toMatchObject({ status: 409 });
    expect(oauth.getAccessToken).not.toHaveBeenCalled();
    expect(http.post).not.toHaveBeenCalled();
  });
  test.each(['REQUESTED', 'UNCERTAIN', 'ACCEPTED'])('Pull %s blocks a new attempt', async (st) => {
    profile.pullRegistrationState = st;
    const http = pullOk();
    await expect(mpesaRegistrationService.registerPull({ ...base, http, oauthClient: oauthOk, eligibility: verified })).rejects.toMatchObject({ status: 409 });
    expect(http.post).not.toHaveBeenCalled();
  });
});

describe('concurrency and audit durability', () => {
  test('two concurrent C2B clicks send exactly one provider request', async () => {
    const http = c2bOk();
    const results = await Promise.allSettled([
      mpesaRegistrationService.registerC2b({ ...base, http, oauthClient: oauthOk }),
      mpesaRegistrationService.registerC2b({ ...base, http, oauthClient: oauthOk }),
    ]);
    expect(http.post).toHaveBeenCalledTimes(1);
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    expect(results.find((r) => r.status === 'rejected').reason.status).toBe(409);
  });
  test('if the durable sending audit cannot be written, nothing is sent and the claim is released', async () => {
    auditRequired.mockImplementation(async () => { throw new Error('audit store down'); });
    const http = c2bOk();
    await expect(mpesaRegistrationService.registerC2b({ ...base, http, oauthClient: oauthOk })).rejects.toThrow('audit store down');
    expect(http.post).not.toHaveBeenCalled();
    expect(profile.c2bRegistrationState).toBe('NONE');
  });
});
