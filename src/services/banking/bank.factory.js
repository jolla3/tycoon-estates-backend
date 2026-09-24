// src/services/banking/bank.factory.js
//
// Section 11: getBankProvider(provider) -> provider instance. Adding KCB,
// Equity, or NCBA later means adding a case here plus a
// providers/<bank>/ folder — nothing else in the app changes.

import { CoopBankProvider } from './providers/coop/coop.provider.js';
import { Errors } from '../../utils/errors.js';

const instances = new Map();

/**
 * Registry of known providers and their verified capabilities.
 * Only COOP is implemented. Others are listed so callers can discover
 * what is NOT available instead of failing deep inside a call.
 */
export const BANK_PROVIDER_REGISTRY = {
  COOP: {
    name: 'COOP',
    implemented: true,
    polling: true,
    statementImport: true,
    webhook: true,
    balance: true,
    accountValidation: true,
  },
  KCB: {
    name: 'KCB',
    implemented: false,
    polling: false,
    statementImport: false,
    webhook: false,
    balance: false,
    accountValidation: false,
  },
  EQUITY: {
    name: 'EQUITY',
    implemented: false,
    polling: false,
    statementImport: false,
    webhook: false,
    balance: false,
    accountValidation: false,
  },
  NCBA: {
    name: 'NCBA',
    implemented: false,
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

export function getBankProviderCapabilities(providerName) {
  const key = String(providerName || '').toUpperCase();
  return BANK_PROVIDER_REGISTRY[key] || null;
}

export function getBankProvider(providerName) {
  const key = String(providerName || '').toUpperCase();
  const caps = BANK_PROVIDER_REGISTRY[key];

  if (!caps || !caps.implemented) {
    throw Errors.BankProviderUnavailable(
      `Unsupported bank provider: ${providerName}. Only COOP is implemented today.`
    );
  }

  if (instances.has(key)) return instances.get(key);

  let provider;
  switch (key) {
    case 'COOP':
      provider = new CoopBankProvider();
      break;
    default:
      throw Errors.BankProviderUnavailable(
        `Unsupported bank provider: ${providerName}. Only COOP is implemented today.`
      );
  }

  instances.set(key, provider);
  return provider;
}
