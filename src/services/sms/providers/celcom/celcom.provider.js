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
    if (!this.partnerId || !this.apiKey) {
      return { success: false, status: 'failed', errorMessage: 'Celcom credentials not configured', retryable: false };
    }

    try {
      const response = await axios.post(this.smsUrl, this._buildBody(mobile, message), {
        headers: { 'Content-Type': 'application/json' },
        timeout: this.timeout,
      });

      const first = response.data?.responses?.[0];
      const code = first?.['respose-code'] ?? first?.['response-code'];

      if ((code === 200 || code === '200') && first?.messageid) {
        return { success: true, status: 'accepted', providerMessageId: String(first.messageid), raw: response.data };
      }

      return {
        success: false,
        status: 'failed',
        errorMessage: first?.['response-description'] || 'Celcom rejected the message',
        retryable: false,
        raw: response.data,
      };
    } catch (error) {
      if (!error.response) {
        return { success: false, status: 'unknown', errorMessage: `${error.code || 'network'} – outcome unknown`, retryable: false };
      }
      const statusCode = error.response.status;
      if (statusCode >= 500) {
        return { success: false, status: 'unknown', errorMessage: `HTTP ${statusCode}`, retryable: false };
      }
      return { success: false, status: 'failed', errorMessage: `HTTP ${statusCode}`, retryable: false };
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
