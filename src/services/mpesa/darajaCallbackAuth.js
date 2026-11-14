// src/services/mpesa/darajaCallbackAuth.js
//
// G5.3 — inbound Daraja callback ingress gate.
//
// Exposure is decided ONLY by a provider-specific verifier object. No verifier exists:
// the owner/provider has not supplied authenticated evidence of an inbound callback
// signature, header, Basic auth, source IP ranges, mTLS, or retry/acknowledgement
// semantics. Outbound OAuth authenticates Tycoon TO Daraja, not Daraja TO Tycoon.
//
// Environment flags (DARAJA_CALLBACKS_ENABLED / DARAJA_CALLBACKS_LAB) are deliberately NOT
// consulted here and cannot open the routes. Do not add a bare "auth verified" switch,
// URL/path secrets, invented headers, invented IP lists, or OAuth-token reuse.

export const NOT_EXPOSED_BODY = Object.freeze({ ResultCode: 1, ResultDesc: 'Not exposed' });

/**
 * Returns the verified provider authenticator, or null. Intentionally returns null until a
 * verifier is implemented from authenticated Daraja evidence, with its own tests and review.
 * @returns {null | { verify: (req) => Promise<boolean>|boolean }}
 */
export function getProviderCallbackVerifier() {
  return null;
}

/** Factory exists so route tests can prove the ONLY way to open ingress is a verifier object. */
export function createDarajaIngressGate(resolveVerifier = getProviderCallbackVerifier) {
  return async function darajaIngressGate(req, res, next) {
    let verifier = null;
    try {
      verifier = resolveVerifier();
    } catch {
      verifier = null;
    }
    if (!verifier || typeof verifier.verify !== 'function') {
      return res.status(503).json(NOT_EXPOSED_BODY);
    }
    try {
      if ((await verifier.verify(req)) === true) return next();
    } catch {
      // fall through: any verifier failure is closed
    }
    return res.status(503).json(NOT_EXPOSED_BODY);
  };
}

export const darajaIngressGate = createDarajaIngressGate();
