// src/services/sms/providers/celcom/celcom.provider.js
//
// Official Celcom Africa "sendsms" API.
//   POST {CELCOM_BASE_URL}/sendsms/
//   Body: { partnerID, apikey, mobile, message, shortcode, pass_type }
//   Response: { responses: [{ "respose-code", "response-description", messageid }] }
//
// NOTE: Celcom's own API uses the typo "respose-code" — normalized once,
// here, so nothing outside this file ever has to know that.
//
// Retry semantics: once a request has been sent to Celcom, we can no
// longer be sure whether it was received (network timeout, 5xx, etc). In
// those cases we report status 'unknown' rather than 'failed' so the
// caller never blindly re-sends and risks double-texting a tenant.

import axios from 'axios';
import { SmsProviderInterface } from '../../sms.interface.js';
import { env } from '../../../../config/environment.js';
import { logger } from '../../../../config/logger.js';

export function normalizeCelcomMobile(value) {
  const compact = String(value ?? '').trim().replace(/[\s()-]/g, '');
  if (/^0[17]\d{8}$/.test(compact)) return `254${compact.slice(1)}`;
  if (/^\+254[17]\d{8}$/.test(compact)) return compact.slice(1);
  if (/^254[17]\d{8}$/.test(compact)) return compact;
  if (/^\+[1-9]\d{7,14}$/.test(compact)) return compact.slice(1);
  if (/^[1-9]\d{7,14}$/.test(compact)) return compact;
  throw new TypeError('Invalid mobile number format');
}

function safeProviderText(value, secrets = []) {
  let text = typeof value === 'string' ? value : String(value ?? '');
  for (const secret of secrets) {
    if (typeof secret === 'string' && secret.length >= 3) text = text.split(secret).join('[redacted]');
  }
  return text
    .replace(/https?:\/\/[^\s]+/gi, '[redacted URL]')
    .replace(/#t=[A-Za-z0-9_-]{20,}/gi, '#t=[redacted]')
    .replace(/\b[A-Za-z0-9_-]{43}\b/g, '[redacted token]')
    .replace(/\+?254[17]\d{8}/g, '[redacted phone]')
    .replace(/\b0[17]\d{8}\b/g, '[redacted phone]')
    .replace(/[\u0000-\u001f\u007f]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 160);
}

function providerFailureDetail(data, secrets) {
  let payload = data;
  if (typeof payload === 'string') {
    try { payload = JSON.parse(payload); }
    catch { payload = { description: payload }; }
  }
  const row = Array.isArray(payload?.responses) ? payload.responses[0] : (payload?.error || payload || {});
  const code = row?.['respose-code'] ?? row?.['response-code'] ?? row?.code ?? row?.error_code;
  let description = row?.['response-description'] ?? row?.['respose-description']
    ?? row?.description ?? row?.detail ?? row?.message ?? row?.error;
  if (Array.isArray(description)) {
    description = description.map((item) => typeof item === 'string' ? item : item?.msg || item?.message || '')
      .filter(Boolean).join('; ');
  } else if (description && typeof description === 'object') {
    description = description.message || description.description || description.msg || '';
  }
  const safeDescription = safeProviderText(description, secrets);
  const safeCode = safeProviderText(code, secrets);
  return [safeCode ? `Celcom ${safeCode}` : null, safeDescription || null].filter(Boolean).join(': ');
}

export class CelcomProvider extends SmsProviderInterface {
  constructor(config = {}) {
    super();
    this.smsUrl = config.smsUrl || `${env.CELCOM_BASE_URL}/sendsms/`;
    this.balanceUrl = config.balanceUrl || `${env.CELCOM_BASE_URL}/getbalance/`;
    this.partnerId = config.partnerId || env.CELCOM_PARTNER_ID;
    this.apiKey = config.apiKey || env.CELCOM_API_KEY;
    this.senderId = config.senderId || env.CELCOM_SENDER_ID;
    this.timeout = config.timeout || 15000;
  }

  getProviderName() {
    return 'celcom';
  }

  _buildBody(mobile, message) {
    return { partnerID: this.partnerId, apikey: this.apiKey, mobile, message, shortcode: this.senderId, pass_type: 'plain' };
  }

  async send(mobile, message) {
    if (!this.partnerId || !this.apiKey || !this.senderId) {
      return { success: false, status: 'failed', errorMessage: 'Celcom credentials or registered sender ID not configured', retryable: false };
    }

    let normalizedMobile;
    try {
      normalizedMobile = normalizeCelcomMobile(mobile);
    } catch {
      return { success: false, status: 'failed', errorMessage: 'Invalid mobile number format', retryable: false };
    }

    try {
      const response = await axios.post(this.smsUrl, this._buildBody(normalizedMobile, message), {
        headers: { 'Content-Type': 'application/json' },
        timeout: this.timeout,
      });

      const first = response.data?.responses?.[0];
      const code = first?.['respose-code'] ?? first?.['response-code'];

      if ((code === 200 || code === '200') && first?.messageid) {
        return { success: true, status: 'accepted', providerMessageId: String(first.messageid) };
      }

      return {
        success: false,
        status: 'failed',
        errorMessage: providerFailureDetail(response.data, [this.apiKey, String(mobile), normalizedMobile, String(message)])
          || 'Celcom rejected the message',
        retryable: false,
      };
    } catch (error) {
      if (!error.response) {
        return { success: false, status: 'unknown', errorMessage: `${error.code || 'network'} – outcome unknown`, retryable: false };
      }
      const statusCode = error.response.status;
      if (statusCode >= 500) {
        return { success: false, status: 'unknown', errorMessage: `HTTP ${statusCode}`, retryable: false };
      }
      const detail = providerFailureDetail(error.response.data, [this.apiKey, String(mobile), normalizedMobile, String(message)]);
      return {
        success: false,
        status: 'failed',
        errorMessage: `HTTP ${statusCode}${detail ? `: ${detail}` : ''}`,
        retryable: false,
      };
    }
  }

  async checkBalance() {
    const resp = await axios.post(
      this.balanceUrl,
      { partnerID: this.partnerId, apikey: this.apiKey },
      { timeout: this.timeout }
    );
    return { balance: resp.data.balance ?? resp.data.credit ?? null, currency: 'KES' };
  }

  async healthCheck() {
    try {
      const balance = await this.checkBalance();
      return { status: 'healthy', balance: balance.balance };
    } catch (err) {
      logger.warn({ error: err.message }, 'Celcom health check failed');
      return { status: 'unhealthy', error: err.message };
    }
  }
}
