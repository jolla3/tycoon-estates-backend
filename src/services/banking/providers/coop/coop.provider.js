// src/services/banking/providers/coop/coop.provider.js
// Co-op Connect 2.0.0 adapter — versioned Enquiry paths, CK/SK auth,
// explicit Account Validation semantics, FullStatement canonical mapping.
// Balance and AccountTransactions polling remain non-operational.

import { BankProviderInterface } from '../../bank.interface.js';
import { CoopAuthService } from './coop.auth.js';
import { coopPost, generateMessageReference } from './coop.client.js';
import {
  AccountFullStatementRequest,
  AccountValidationRequest,
  getCoopMessageCode,
} from './coop.schemas.js';
import {
  mapCoopWebhookNotification,
  mapCoopFullStatementItem,
} from './coop.mapper.js';
import { env } from '../../../../config/environment.js';
import { encryptionUtil } from '../../../../utils/encryption.js';
import { logger } from '../../../../config/logger.js';
import { Errors } from '../../../../utils/errors.js';

export const COOP_RESOURCE_PATHS = {
  ACCOUNT_VALIDATION: '/Enquiry/Validation/Account/1.0.0',
  ACCOUNT_TRANSACTIONS: '/Enquiry/AccountTransactions/1.0.0/Account',
  MINI_STATEMENT: '/Enquiry/MiniStatement/Account/1.0.0',
  ACCOUNT_FULL_STATEMENT: '/Enquiry/FullStatement/Account/1.0.0',
};

export class CoopBankProvider extends BankProviderInterface {
  constructor(config = {}) {
    super();
    this.baseUrl = config.baseUrl || env.COOP_BASE_URL;
    this.tokenUrl =
      config.tokenUrl
      || env.COOP_TOKEN_URL
      || (this.baseUrl ? `${String(this.baseUrl).replace(/\/$/, '')}/token` : null);

    const consumerKey = config.consumerKey ?? config.clientId;
    const consumerSecret = config.consumerSecret ?? config.clientSecret;

    this.auth = new CoopAuthService({
      tokenUrl: this.tokenUrl,
      consumerKey,
      consumerSecret,
      // Scope only from trusted config — never customer form input.
      scope: config.scope || env.COOP_SCOPE || null,
      connectionId: config.connectionId || null,
      credentialVersion: config.credentialVersion || null,
    });
    this.insBasicSecret = config.insBasicSecret;
    this.connectionId = config.connectionId || null;
    this.credentialVersion = config.credentialVersion || null;
  }

  getProviderName() {
    return 'COOP';
  }

  async authenticate() {
    return this.auth.getAccessToken();
  }

  async getTransactions() {
    throw Errors.Conflict(
      'Co-op AccountTransactions polling is not operational until the item schema is verified'
    );
  }

  async getFullStatement(bankAccount, startDate, endDate) {
    const token = await this.authenticate();
    const accountNumber = encryptionUtil.decrypt(bankAccount.accountNumberEncrypted);

    const requestBody = AccountFullStatementRequest.parse({
      MessageReference: generateMessageReference(),
      AccountNumber: accountNumber,
      StartDate: startDate,
      EndDate: endDate,
    });

    const data = await coopPost({
      baseUrl: this.baseUrl,
      path: COOP_RESOURCE_PATHS.ACCOUNT_FULL_STATEMENT,
      token,
      body: requestBody,
      timeout: 20000,
    });

    const items = Array.isArray(data.Transactions) ? data.Transactions : [];
    return items.map(mapCoopFullStatementItem);
  }

  async getAccountBalance() {
    throw Errors.Conflict('Co-op Account Balance is not operationally enabled');
  }

  /**
   * MessageCode 0 = valid; -1 = invalid account.
   * Unknown/missing codes fail closed (provider unavailable), not INVALID_REQUEST.
   */
  async validateAccount(bankAccount) {
    const token = await this.authenticate();
    const accountNumber = encryptionUtil.decrypt(bankAccount.accountNumberEncrypted);

    const requestBody = AccountValidationRequest.parse({
      MessageReference: generateMessageReference(),
      AccountNumber: accountNumber,
    });

    const data = await coopPost({
      baseUrl: this.baseUrl,
      path: COOP_RESOURCE_PATHS.ACCOUNT_VALIDATION,
      token,
      body: requestBody,
      allowNonSuccessMessageCode: true,
    });

    const code = getCoopMessageCode(data);
    if (code === '0') {
      return { valid: true, messageCode: code };
    }
    if (code === '-1') {
      return { valid: false, messageCode: code };
    }

    logger.warn(
      { messageCode: code, connectionId: this.connectionId },
      'Co-op Account Validation returned unexpected MessageCode'
    );
    throw Errors.BankProviderUnavailable(
      'Co-op Account Validation returned an unexpected response'
    );
  }

  async registerTransactionNotification() {
    logger.warn(
      'registerTransactionNotification() is a no-op: Co-op Connect docs show no REST registration endpoint'
    );
    return { registered: false, reason: 'not_documented_as_an_api_call' };
  }

  normalizeTransaction(raw) {
    const safe = { ...raw };
    if (Object.prototype.hasOwnProperty.call(safe, 'Basic')) {
      safe.Basic = '[redacted]';
    }
    return mapCoopWebhookNotification(safe);
  }

  verifyWebhookSignature(req) {
    if (!this.insBasicSecret) {
      logger.warn('COOP_INS_BASIC_SECRET is not configured — rejecting all Co-op webhook calls');
      return false;
    }
    const headerValue = req.headers['basic'];
    const bodyValue = req.body?.Basic;
    return headerValue === this.insBasicSecret || bodyValue === this.insBasicSecret;
  }
}
