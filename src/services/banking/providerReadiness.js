// src/services/banking/providerReadiness.js
//
// Capability readiness is multi-dimensional — adapter existence ≠ operational.

/**
 * @typedef {object} CapabilityReadiness
 * @property {boolean} adapterPresent
 * @property {boolean} contractVerified
 * @property {boolean} capabilityImplemented
 * @property {boolean} credentialsConfigurable
 * @property {boolean} sandboxVerified
 * @property {boolean} operationalReady
 * @property {string[]} blockers
 * @property {string|null} evidenceNote
 */

export function capability({
  adapterPresent = false,
  contractVerified = false,
  capabilityImplemented = false,
  credentialsConfigurable = false,
  sandboxVerified = false,
  blockers = [],
  evidenceNote = null,
} = {}) {
  const operationalReady = Boolean(
    adapterPresent
    && contractVerified
    && capabilityImplemented
    && credentialsConfigurable
    // sandboxVerified is recommended but not strictly required for operationalReady
    // when contract is verified from official docs; still report it honestly.
  ) && blockers.length === 0;

  return {
    adapterPresent,
    contractVerified,
    capabilityImplemented,
    credentialsConfigurable,
    sandboxVerified,
    operationalReady: operationalReady && (sandboxVerified || contractVerified),
    // Tighten: operational requires contract verified + implemented + no blockers.
    // Sandbox verified is reported separately.
    blockers: [...blockers],
    evidenceNote,
  };
}

/** Recompute operationalReady more carefully: require contract + implemented + no blockers. */
export function finalizeCapability(c) {
  const operationalReady = Boolean(
    c.adapterPresent
    && c.contractVerified
    && c.capabilityImplemented
    && c.blockers.length === 0
  );
  return { ...c, operationalReady };
}
