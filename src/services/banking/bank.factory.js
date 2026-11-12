// src/services/banking/bank.factory.js
//
// Provider registry + connection-scoped adapter construction.
// Customer auth state is never shared via a provider-name singleton.

import { CoopBankProvider } from './providers/coop/coop.provider.js';
import { getCoopCapabilityProfile } from './providers/coop/coop.readiness.js';
import { KcbBankProvider, getKcbCapabilityProfile } from './providers/kcb/kcb.provider.js';
import { EquityBankProvider, getEquityCapabilityProfile } from './providers/equity/equity.provider.js';
import { NcbaBankProvider, getNcbaCapabilityProfile } from './providers/ncba/ncba.provider.js';
import { Errors } from '../../utils/errors.js';

/**
 * Registry: reserved identifiers always present.
 * `implemented` = adapter code path for real API calls exists and is intended for use.
 * `operationalReady` = overall gate for customer traffic (strict).
 * Per-capability detail lives in getProviderReadiness().
 */
export const BANK_PROVIDER_REGISTRY = {
  COOP: {
    name: 'COOP',
    adapterPresent: true,
    implemented: true,
    operationalReady: false,
    polling: false,
    statementImport: true,
    webhook: true,
    balance: true,
    accountValidation: true,
  },
  KCB: {
    name: 'KCB',
    adapterPresent: true,
    implemented: false,
    operationalReady: false,
    polling: false,
    statementImport: false,
    webhook: false,
    balance: false,
    accountValidation: false,
  },
  EQUITY: {
    name: 'EQUITY',
    adapterPresent: true,
    implemented: false,
    operationalReady: false,
    polling: false,
    statementImport: false,
    webhook: false,
    balance: false,
    accountValidation: false,
  },
  NCBA: {
    name: 'NCBA',
    adapterPresent: true,
    implemented: false,
    operationalReady: false,
    polling: false,
    statementImport: false,
    webhook: false,
    balance: false,
    accountValidation: false,
  },
};

export function listBankProviders() {
  return Object.values(BANK_PROVIDER_REGISTRY);
}

/** Providers with implemented:true (may still be non-operational pending verification). */
export function listOperationalBankProviders() {
  return Object.values(BANK_PROVIDER_REGISTRY).filter((p) => p.implemented && p.operationalReady);
}

/** Providers that have adapter modules registered (including disabled shells). */
export function listRegisteredBankProviders() {
  return Object.values(BANK_PROVIDER_REGISTRY).filter((p) => p.adapterPresent);
}

export function getBankProviderCapabilities(providerName) {
  const key = String(providerName || '').toUpperCase();
  return BANK_PROVIDER_REGISTRY[key] || null;
}

export function getProviderReadiness(providerName) {
  const key = String(providerName || '').toUpperCase();
  switch (key) {
    case 'COOP':
      return getCoopCapabilityProfile();
    case 'KCB':
      return getKcbCapabilityProfile();
    case 'EQUITY':
      return getEquityCapabilityProfile();
    case 'NCBA':
      return getNcbaCapabilityProfile();
    default:
      return null;
  }
}

export function isNonProductionLabOverrideEnabled(
  enabled,
  nodeEnv = process.env.NODE_ENV || 'development'
) {
  return enabled === true && String(nodeEnv).toLowerCase() !== 'production';
}

export function assertProviderOperational(providerName, {
  allowLab = false,
  labMode = process.env.COOP_BANK_LAB_MODE === '1',
  nodeEnv = process.env.NODE_ENV || 'development',
} = {}) {
  const key = String(providerName || '').toUpperCase();
  const caps = getBankProviderCapabilities(key);

  if (!caps) {
    throw Errors.BankProviderUnavailable(`Unknown bank provider: ${providerName}`);
  }
  if (!caps.implemented) {
    throw Errors.BankProviderUnavailable(
      `Unsupported bank provider: ${providerName}. Adapter is registered but not operationally implemented.`
    );
  }

  const permittedCoopLab = (
    allowLab
    && key === 'COOP'
    && isNonProductionLabOverrideEnabled(labMode, nodeEnv)
  );

  if (caps.operationalReady !== true && !permittedCoopLab) {
    throw Errors.BankProviderUnavailable(
      `Bank provider ${key} is implemented but not operationally ready`
    );
  }

  return caps;
}

/**
 * Connection-scoped adapter. No provider-name singleton cache of customer tokens.
 */
export function createBankProviderForConnection(providerName, credentialContext, cacheKey = {}) {
  const key = String(providerName || '').toUpperCase();
  const caps = getBankProviderCapabilities(key);
  if (!caps || !caps.adapterPresent) {
    throw Errors.BankProviderUnavailable(`Unknown bank provider: ${providerName}`);
  }

  if (!credentialContext || typeof credentialContext !== 'object') {
    throw Errors.BankAuthFailed('Connection credential context is required');
  }

  switch (key) {
    case 'COOP':
      if (!caps.implemented) {
        throw Errors.BankProviderUnavailable('COOP adapter is not implemented');
      }
      // The API endpoint and inbound webhook verification secret are
      // platform configuration, never tenant-controlled credential material.
      // CoopBankProvider resolves COOP_BASE_URL from trusted environment config.
      return new CoopBankProvider({
        clientId: credentialContext.clientId,
        clientSecret: credentialContext.clientSecret,
        username: credentialContext.username,
        password: credentialContext.password,
        scope: credentialContext.scope,
        connectionId: cacheKey.connectionId,
        credentialVersion: cacheKey.credentialVersion,
      });
    case 'KCB':
      return new KcbBankProvider(credentialContext);
    case 'EQUITY':
      return new EquityBankProvider(credentialContext);
    case 'NCBA':
      return new NcbaBankProvider(credentialContext);
    default:
      throw Errors.BankProviderUnavailable(`Unsupported bank provider: ${providerName}`);
  }
}

/**
 * @deprecated Prefer createBankProviderForConnection for customer traffic.
 * Constructs a COOP adapter without secrets (auth will fail closed) or
 * throws for unimplemented providers — used by registry unit tests.
 */
export function getBankProvider(providerName) {
  const key = String(providerName || '').toUpperCase();
  assertProviderOperational(key);
  return createBankProviderForConnection(key, {}, {});
}
