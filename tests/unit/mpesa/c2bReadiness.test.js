// C2B-first readiness rules. Pure functions only; no database.
import '../../setup.js';
import {
  c2bReadinessBlockers, pullAdvisories, activationBlockers, resumeBlockers, lifecycleAvailability,
  hasEligibleEstateMapping,
} from '../../../src/services/mpesa/mpesaReadiness.js';
import { mpesaBlockers } from '../../../src/services/platformIntegrations.service.js';
import { handleC2bValidation, C2B_EXTERNAL_VALIDATION_ENABLED } from '../../../src/services/mpesa/darajaC2b.service.js';
import {
  lifecycleActivateSchema, lifecycleSuspendSchema, lifecycleResumeSchema,
} from '../../../src/routes/platform.routes.js';

// Test-local configuration; the version is NOT a product constant.
const config = {
  configured: true, environment: 'sandbox', configId: 'daraja-sandbox', version: 'v-current',
  confirmationUrl: 'https://cb.example/confirm', validationUrl: 'https://cb.example/validate',
};
const draftRegistered = {
  operationalState: 'DRAFT', c2bRegistrationState: 'ACCEPTED', callbackCapability: 'UNKNOWN',
  pullCapability: 'UNKNOWN', pullRegistrationState: 'NONE', lifecycleRevision: 0,
  businessShortCode: '600995', merchantType: 'BUY_GOODS_TILL',
  c2bRegistration: {
    environment: 'sandbox', configId: 'daraja-sandbox', configVersion: 'v-current',
    shortCode: '600995', merchantType: 'BUY_GOODS_TILL',
    confirmationUrl: config.confirmationUrl, validationUrl: config.validationUrl,
  },
};
const ctx = { activeEstateCount: 1, config, clientActive: true };

describe('Pull never blocks C2B readiness', () => {
  test('Pull UNKNOWN/unregistered adds no C2B blocker', () => {
    const b = c2bReadinessBlockers({ ...draftRegistered, callbackCapability: 'VERIFIED' }, ctx);
    expect(b).toEqual([]);
    expect(b.some((x) => x.startsWith('PULL'))).toBe(false);
  });
  test('Pull appears only as an advisory', () => {
    expect(pullAdvisories(draftRegistered)).toEqual(['PULL_UNKNOWN', 'PULL_REGISTRATION_NONE']);
    expect(mpesaBlockers(draftRegistered, ctx).some((x) => x.startsWith('PULL'))).toBe(false);
  });
});

describe('registration evidence must match the CURRENT callback configuration', () => {
  const ready = { ...draftRegistered, callbackCapability: 'VERIFIED' };
  test('matching evidence adds no blocker', () => {
    expect(c2bReadinessBlockers(ready, ctx)).toEqual([]);
  });
  test('a config version change makes old registration stale', () => {
    expect(c2bReadinessBlockers(ready, { ...ctx, config: { ...config, version: 'v-next' } })).toContain('C2B_REGISTRATION_STALE_CONFIG');
  });
  test('changed endpoint URL, environment and merchant are each detected', () => {
    expect(c2bReadinessBlockers(ready, { ...ctx, config: { ...config, confirmationUrl: 'https://other/confirm' } })).toContain('C2B_REGISTRATION_STALE_CONFIG');
    expect(c2bReadinessBlockers(ready, { ...ctx, config: { ...config, environment: 'production' } })).toContain('C2B_REGISTRATION_ENVIRONMENT_MISMATCH');
    const wrong = { ...ready, c2bRegistration: { ...ready.c2bRegistration, shortCode: '111' } };
    expect(c2bReadinessBlockers(wrong, ctx)).toContain('C2B_REGISTRATION_MERCHANT_MISMATCH');
  });
  test('each missing identity/config evidence field is an explicit blocker, never a silent pass', () => {
    for (const k of ['environment', 'configId', 'configVersion', 'confirmationUrl', 'validationUrl']) {
      const e = { ...ready.c2bRegistration, [k]: null };
      expect(c2bReadinessBlockers({ ...ready, c2bRegistration: e }, ctx)).toContain('C2B_REGISTRATION_EVIDENCE_MISSING');
    }
    for (const k of ['shortCode', 'merchantType']) {
      const e = { ...ready.c2bRegistration, [k]: null };
      expect(c2bReadinessBlockers({ ...ready, c2bRegistration: e }, ctx)).toContain('C2B_REGISTRATION_IDENTITY_EVIDENCE_MISSING');
    }
  });
  test('legacy evidence without shortCode/merchantType (current profiles) keeps activation blocked', () => {
    const legacy = { ...draftRegistered, c2bRegistration: { ...draftRegistered.c2bRegistration, shortCode: undefined, merchantType: undefined } };
    expect(activationBlockers(legacy, ctx)).toContain('C2B_REGISTRATION_IDENTITY_EVIDENCE_MISSING');
  });
  test('missing evidence and missing/unconfigured config fail closed', () => {
    expect(c2bReadinessBlockers({ ...ready, c2bRegistration: {} }, ctx)).toContain('C2B_REGISTRATION_EVIDENCE_MISSING');
    expect(c2bReadinessBlockers(ready, { activeEstateCount: 1 })).toContain('CALLBACK_CONFIG_UNAVAILABLE');
    expect(c2bReadinessBlockers(ready, { ...ctx, config: { configured: false } })).toContain('CALLBACK_CONFIG_UNAVAILABLE');
  });
});

describe('registration success is not callback readiness or activation', () => {
  test('registered but callback UNKNOWN still blocks activation', () => {
    const b = activationBlockers(draftRegistered, ctx);
    expect(b).toContain('CALLBACK_UNKNOWN');
    expect(lifecycleAvailability(draftRegistered, ctx).canActivate).toBe(false);
  });
  test('unregistered C2B and missing estate mapping block activation', () => {
    const b = activationBlockers({ ...draftRegistered, c2bRegistrationState: 'NONE', callbackCapability: 'VERIFIED' }, { activeEstateCount: 0, config, clientActive: true });
    expect(b).toEqual(['C2B_REGISTRATION_NONE', 'NO_ACTIVE_ESTATE_MAPPING']);
  });
  test('fully ready DRAFT profile may be activated; ACTIVE and SUSPENDED may not use activate', () => {
    const ready = { ...draftRegistered, callbackCapability: 'VERIFIED' };
    expect(activationBlockers(ready, ctx)).toEqual([]);
    expect(activationBlockers({ ...ready, operationalState: 'ACTIVE' }, ctx)).toContain('ALREADY_ACTIVE');
    expect(activationBlockers({ ...ready, operationalState: 'SUSPENDED' }, ctx)).toContain('SUSPENDED_USE_RESUME');
  });
});

describe('suspend / resume availability', () => {
  test('only ACTIVE can be suspended; only SUSPENDED+ready can resume', () => {
    const ready = { ...draftRegistered, callbackCapability: 'VERIFIED' };
    expect(lifecycleAvailability({ ...ready, operationalState: 'ACTIVE' }, ctx).canSuspend).toBe(true);
    expect(lifecycleAvailability(ready, ctx).canSuspend).toBe(false);
    expect(resumeBlockers({ ...ready, operationalState: 'SUSPENDED' }, ctx)).toEqual([]);
    expect(resumeBlockers(ready, ctx)).toContain('OPERATIONAL_STATE_DRAFT');
  });
});

describe('lifecycle request schemas', () => {
  test('require expectedRevision and reject caller-supplied state', () => {
    expect(lifecycleActivateSchema.safeParse({}).success).toBe(false);
    expect(lifecycleActivateSchema.safeParse({ expectedRevision: 0 }).success).toBe(true);
    expect(lifecycleActivateSchema.safeParse({ expectedRevision: 0, operationalState: 'ACTIVE' }).success).toBe(false);
    expect(lifecycleResumeSchema.safeParse({ expectedRevision: 2 }).success).toBe(true);
  });
  test('suspend requires a reason', () => {
    expect(lifecycleSuspendSchema.safeParse({ expectedRevision: 1 }).success).toBe(false);
    expect(lifecycleSuspendSchema.safeParse({ expectedRevision: 1, reason: 'ok' }).success).toBe(false);
    expect(lifecycleSuspendSchema.safeParse({ expectedRevision: 1, reason: 'Provider incident' }).success).toBe(true);
  });
});

describe('external C2B validation fails closed', () => {
  test('is disabled and rejects without any lookup', async () => {
    expect(C2B_EXTERNAL_VALIDATION_ENABLED).toBe(false);
    const res = await handleC2bValidation({ BusinessShortCode: '600995', TransAmount: '10' });
    expect(res).toEqual({ ResultCode: 'C2B00016', ResultDesc: 'Rejected' });
    expect(await handleC2bValidation(null)).toEqual({ ResultCode: 'C2B00016', ResultDesc: 'Rejected' });
  });
});

describe('active client lifecycle precondition', () => {
  const ready = { ...draftRegistered, callbackCapability: 'VERIFIED' };
  test('inactive clients cannot activate or resume, but ACTIVE profiles can still be suspended', () => {
    const inactive = { ...ctx, clientActive: false };
    expect(activationBlockers(ready, inactive)).toContain('CLIENT_INACTIVE');
    expect(resumeBlockers({ ...ready, operationalState: 'SUSPENDED' }, inactive)).toContain('CLIENT_INACTIVE');
    expect(lifecycleAvailability({ ...ready, operationalState: 'ACTIVE' }, inactive).canSuspend).toBe(true);
  });
});

describe('eligible estate mapping predicate', () => {
  test('requires ACTIVE mapping and backend-confirmed eligible Estate', () => {
    expect(hasEligibleEstateMapping([{ status: 'ACTIVE', estateEligible: true }])).toBe(true);
    expect(hasEligibleEstateMapping([{ status: 'ACTIVE', estateEligible: false }])).toBe(false);
    expect(hasEligibleEstateMapping([{ status: 'INACTIVE', estateEligible: true }])).toBe(false);
    expect(hasEligibleEstateMapping([])).toBe(false);
  });
});
