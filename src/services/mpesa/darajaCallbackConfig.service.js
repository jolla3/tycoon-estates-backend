// Platform-owned shared Daraja callback configuration (one set per Daraja environment).
// Clients never host or supply callback URLs. The version is a content hash, so any change to
// the URL set produces a new version that registration evidence can be compared against.
import crypto from 'crypto';
import { env } from '../../config/environment.js';
import { DARAJA_WEBHOOK_PATHS } from './daraja.constants.js';

export function getCallbackConfig(envLike = env) {
  const environment = envLike.DARAJA_ENVIRONMENT || 'sandbox';
  const base = String(envLike.DARAJA_CALLBACK_BASE_URL || '').trim().replace(/\/+$/, '');
  if (!base) return { configured: false, reason: 'callback_base_url_missing', environment };
  let parsed;
  try { parsed = new URL(base); } catch { return { configured: false, reason: 'callback_base_url_invalid', environment }; }
  if (parsed.protocol !== 'https:') return { configured: false, reason: 'callback_base_url_not_https', environment };
  if (parsed.username || parsed.password || parsed.search || parsed.hash) {
    return { configured: false, reason: 'callback_base_url_unsafe', environment };
  }
  const prefix = `${parsed.origin}${parsed.pathname.replace(/\/+$/, '')}/api/v1/webhooks`;
  const urls = {
    confirmationUrl: `${prefix}${DARAJA_WEBHOOK_PATHS.c2bConfirmation}`,
    validationUrl: `${prefix}${DARAJA_WEBHOOK_PATHS.c2bValidation}`,
    pullResultsUrl: `${prefix}${DARAJA_WEBHOOK_PATHS.pullResult}`,
  };
  const version = crypto.createHash('sha256').update(JSON.stringify([environment, urls])).digest('hex').slice(0, 12);
  return { configured: true, configId: `daraja-${environment}`, version, environment, ...urls };
}
