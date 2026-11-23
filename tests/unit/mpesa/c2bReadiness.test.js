// C2B-first readiness rules. Pure functions only; no database.
import '../../setup.js';
import {
  c2bReadinessBlockers, pullAdvisories, activationBlockers, resumeBlockers, lifecycleAvailability,
} from '../../../src/services/mpesa/mpesaReadiness.js';
import { mpesaBlockers } from '../../../src/services/platformIntegrations.service.js';
import { handleC2bValidation, C2B_EXTERNAL_VALIDATION_ENABLED } from '../../../src/services/mpesa/darajaC2b.service.js';
import {
  lifecycleActivateSchema, lifecycleSuspendSchema, lifecycleResumeSchema,
} from '../../../src/routes/platform.routes.js';

const draftRegistered = {
  operationalState: 'DRAFT', c2bRegistrationState: 'ACCEPTED', callbackCapability: 'UNKNOWN',
  pullCapability: 'UNKNOWN', pullRegistrationState: 'NONE', lifecycleRevision: 0,
};

describe('Pull never blocks C2B readiness', () => {
  test('Pull UNKNOWN/unregistered adds no C2B blocker', () => {
    const b = c2bReadinessBlockers({ ...draftRegistered, callbackCapability: 'VERIFIED' }, { activeEstateCount: 1 });
    expect(b).toEqual([]);
    expect(b.some((x) => x.startsWith('PULL'))).toBe(false);
  });
  test('Pull appears only as an advisory', () => {
    expect(pullAdvisories(draftRegistered)).toEqual(['PULL_UNKNOWN', 'PULL_REGISTRATION_NONE']);
    expect(mpesaBlockers(draftRegistered).some((x) => x.startsWith('PULL'))).toBe(false);
  });
});

describe('registration success is not callback readiness or activation', () => {
  test('registered but callback UNKNOWN still blocks activation', () => {
    const b = activationBlockers(draftRegistered, { activeEstateCount: 1 });
    expect(b).toContain('CALLBACK_UNKNOWN');
    expect(lifecycleAvailability(draftRegistered, { activeEstateCount: 1 }).canActivate).toBe(false);
  });
  test('unregistered C2B and missing estate mapping block activation', () => {
    const b = activationBlockers({ ...draftRegistered, c2bRegistrationState: 'NONE', callbackCapability: 'VERIFIED' }, { activeEstateCount: 0 });
    expect(b).toEqual(['C2B_REGISTRATION_NONE', 'NO_ACTIVE_ESTATE_MAPPING']);
  });
  test('fully ready DRAFT profile may be activated; ACTIVE and SUSPENDED may not use activate', () => {
    const ready = { ...draftRegistered, callbackCapability: 'VERIFIED' };
    expect(activationBlockers(ready, { activeEstateCount: 1 })).toEqual([]);
    expect(activationBlockers({ ...ready, operationalState: 'ACTIVE' }, { activeEstateCount: 1 })).toContain('ALREADY_ACTIVE');
    expect(activationBlockers({ ...ready, operationalState: 'SUSPENDED' }, { activeEstateCount: 1 })).toContain('SUSPENDED_USE_RESUME');
  });
});

describe('suspend / resume availability', () => {
  test('only ACTIVE can be suspended; only SUSPENDED+ready can resume', () => {
    const ready = { ...draftRegistered, callbackCapability: 'VERIFIED' };
    expect(lifecycleAvailability({ ...ready, operationalState: 'ACTIVE' }, { activeEstateCount: 1 }).canSuspend).toBe(true);
    expect(lifecycleAvailability(ready, { activeEstateCount: 1 }).canSuspend).toBe(false);
    expect(resumeBlockers({ ...ready, operationalState: 'SUSPENDED' }, { activeEstateCount: 1 })).toEqual([]);
    expect(resumeBlockers(ready, { activeEstateCount: 1 })).toContain('OPERATIONAL_STATE_DRAFT');
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
