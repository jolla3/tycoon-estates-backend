// src/services/mpesa/mpesaReadiness.js
//
// Pure, side-effect-free C2B-first readiness rules. Four concepts stay separate:
//   1. provider registration state   (c2bRegistrationState / pullRegistrationState)
//   2. callback capability           (callbackCapability: evidence of real, trusted delivery)
//   3. Pull capability               (pullCapability: OPTIONAL, never a C2B prerequisite)
//   4. financial posting permission  (operationalState === 'ACTIVE', set only by the explicit
//                                     Superadmin lifecycle operations)
// Registration success proves neither callback capability nor posting permission.

const REGISTERED = ['ACCEPTED', 'ALREADY_REGISTERED'];
export const ACTIVATABLE_STATES = ['DRAFT', 'NOT_READY'];

/**
 * Reasons this profile is not ready to carry C2B financial posting. Derived ONLY from stored
 * state. Pull state is deliberately absent: Pull is optional and cannot block C2B.
 */
export function c2bReadinessBlockers(p, { activeEstateCount } = {}) {
  const b = [];
  if (!REGISTERED.includes(p.c2bRegistrationState)) b.push(`C2B_REGISTRATION_${p.c2bRegistrationState}`);
  if (p.callbackCapability !== 'VERIFIED') b.push(`CALLBACK_${p.callbackCapability}`);
  if (activeEstateCount !== undefined && activeEstateCount < 1) b.push('NO_ACTIVE_ESTATE_MAPPING');
  return b;
}

/** Non-blocking Pull information. Never included in blockers. */
export function pullAdvisories(p) {
  const a = [];
  if (p.pullCapability !== 'VERIFIED') a.push(`PULL_${p.pullCapability}`);
  if (!REGISTERED.includes(p.pullRegistrationState)) a.push(`PULL_REGISTRATION_${p.pullRegistrationState}`);
  return a;
}

/** Blockers for the explicit ACTIVATE operation (state precondition + C2B readiness). */
export function activationBlockers(p, ctx = {}) {
  const b = [];
  if (p.operationalState === 'ACTIVE') b.push('ALREADY_ACTIVE');
  else if (p.operationalState === 'SUSPENDED') b.push('SUSPENDED_USE_RESUME');
  else if (!ACTIVATABLE_STATES.includes(p.operationalState)) b.push(`OPERATIONAL_STATE_${p.operationalState}`);
  return [...b, ...c2bReadinessBlockers(p, ctx)];
}

/** Blockers for RESUME: must be SUSPENDED and still satisfy C2B readiness. */
export function resumeBlockers(p, ctx = {}) {
  const b = p.operationalState === 'SUSPENDED' ? [] : [`OPERATIONAL_STATE_${p.operationalState}`];
  return [...b, ...c2bReadinessBlockers(p, ctx)];
}

/**
 * What the backend will currently allow. The UI renders these flags; it never decides them.
 * `lifecycleRevision` must be echoed back on every lifecycle call (stale-update protection).
 */
export function lifecycleAvailability(p, ctx = {}) {
  const activate = activationBlockers(p, ctx);
  const resume = resumeBlockers(p, ctx);
  return {
    revision: p.lifecycleRevision ?? 0,
    canActivate: activate.length === 0,
    canSuspend: p.operationalState === 'ACTIVE',
    canResume: resume.length === 0,
    activationBlockers: activate,
    resumeBlockers: resume,
  };
}
