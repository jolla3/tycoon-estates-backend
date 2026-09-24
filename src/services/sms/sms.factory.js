// src/services/sms/sms.factory.js
//
// Section 39: getSmsProvider(name) -> provider instance. Adding a second
// SMS provider later means a new providers/<name>/ folder + a case here.

import { CelcomProvider } from './providers/celcom/celcom.provider.js';

const instances = new Map();

export function getSmsProvider(providerName = 'celcom') {
  const key = String(providerName).toLowerCase();
  if (instances.has(key)) return instances.get(key);

  let provider;
  switch (key) {
    case 'celcom':
      provider = new CelcomProvider();
      break;
    default:
      throw new Error(`Unsupported SMS provider: ${providerName}`);
  }

  instances.set(key, provider);
  return provider;
}
