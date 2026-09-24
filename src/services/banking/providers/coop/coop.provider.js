// src/services/banking/providers/coop/coop.provider.js
//
// Implements BankProviderInterface for Co-operative Bank of Kenya against
// the ACTUAL Co-op Connect 2.0.0 documentation (replacing the earlier
// version's invented generic-REST endpoints). Covers:
//   - AccountTransactions    (recent transactions)
//   - AccountFullStatement   (historical / date-range sync & reconciliation)
//   - AccountBalance
//   - AccountValidation      (used when connecting/verifying an account)
//   - SendTransactionINS     (Co-op -> our webhook; see verifyWebhookSignature)
//
// Deliberately NOT implemented (out of scope for a payment-monitoring
// system, per the V2 brief): IFTAccountToAccount, PesaLinkSendToAccount,
// PesaLinkSendToPhone, SendToMPesa, TransactionStatus, ExchangeRate.

import { BankProviderInterface } from '../../bank.interface.js';
import { CoopAuthService } from './coop.auth.js';
import { coopPost, generateMessageReference } from './coop.client.js';
import {
  AccountTransactionsRequest,
  AccountFullStatementRequest,
  AccountBalanceRequest,
  AccountValidationRequest,
} from './coop.schemas.js';
import { mapCoopWebhookNotification, mapCoopPolledTransaction, extractAccountNumber } from './coop.mapper.js';
import { env } from '../../../../config/environment.js';
import { encryptionUtil } from '../../../../utils/encryption.js';
import { logger } from '../../../../config/logger.js';

const ENDPOINTS = {
  ACCOUNT_TRANSACTIONS: '/AccountTransactions',
  ACCOUNT_FULL_STATEMENT: '/AccountFullStatement',
  ACCOUNT_BALANCE: '/AccountBalance',
  ACCOUNT_VALIDATION: '/AccountValidation',
};

export class CoopBankProvider extends BankProviderInterface {
  constructor(config = {}) {
    super();
    this.baseUrl = config.baseUrl || env.COOP_BASE_URL;
    this.auth = new CoopAuthService({
      baseUrl: this.baseUrl,
      clientId: config.clientId || env.COOP_CLIENT_ID,
      clientSecret: config.clientSecret || env.COOP_CLIENT_SECRET,
      username: config.username || env.COOP_USERNAME,
      password: config.password || env.COOP_PASSWORD,
      scope: config.scope || env.COOP_SCOPE,
    });
    this.insBasicSecret = config.insBasicSecret || env.COOP_INS_BASIC_SECRET;
  }

  getProviderName() {
    return 'COOP';
  }

  async authenticate() {
    return this.auth.getAccessToken();
  }

  async getTransactions(bankAccount, { noOfTransactions = 50 } = {}) {
    const token = await this.authenticate();
    const accountNumber = encryptionUtil.decrypt(bankAccount.accountNumberEncrypted);

    const requestBody = AccountTransactionsRequest.parse({
      MessageReference: generateMessageReference(),
      AccountNumber: accountNumber,
      NoOfTransactions: noOfTransactions,
    });

    const data = await coopPost({ baseUrl: this.baseUrl, path: ENDPOINTS.ACCOUNT_TRANSACTIONS, token, body: requestBody });
    return (data.Transactions || []).map(mapCoopPolledTransaction);
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

    const data = await coopPost({ baseUrl: this.baseUrl, path: ENDPOINTS.ACCOUNT_FULL_STATEMENT, token, body: requestBody, timeout: 20000 });
    return (data.Transactions || []).map(mapCoopPolledTransaction);
  }

  async getAccountBalance(bankAccount) {
    const token = await this.authenticate();
    const accountNumber = encryptionUtil.decrypt(bankAccount.accountNumberEncrypted);

    const requestBody = AccountBalanceRequest.parse({ MessageReference: generateMessageReference(), AccountNumber: accountNumber });
    const data = await coopPost({ baseUrl: this.baseUrl, path: ENDPOINTS.ACCOUNT_BALANCE, token, body: requestBody });

    return {
      balance: data.ClearedBalance,
      bookedBalance: data.BookedBalance,
      availableBalance: data.AvailableBalance,
      currency: data.Currency || 'KES',
      accountName: data.AccountName,
    };
  }

  /** Used when connecting/verifying a bank account (section 12) — confirms the account number is real before we start expecting payments on it. */
  async validateAccount(bankAccount) {
    const token = await this.authenticate();
    const accountNumber = encryptionUtil.decrypt(bankAccount.accountNumberEncrypted);

    const requestBody = AccountValidationRequest.parse({ MessageReference: generateMessageReference(), AccountNumber: accountNumber });
    const data = await coopPost({ baseUrl: this.baseUrl, path: ENDPOINTS.ACCOUNT_VALIDATION, token, body: requestBody });
    return { valid: true, raw: data };
  }

  /**
   * IMPORTANT CORRECTION from the earlier version: the supplied Co-op
   * docs do NOT document a REST call for "register my webhook URL with
   * Co-op". SendTransactionINS describes what CO-OP SENDS TO US, not
   * something we POST to register. Subscribing an account to INS
   * notifications and configuring the callback URL appears to be a
   * developer-portal / account-manager step on Co-op's side, not an API
   * call this codebase can make. This method is intentionally a no-op
   * that says so, rather than fabricating a fake registration endpoint.
   */
  async registerTransactionNotification(_bankAccount) {
    logger.warn(
      'registerTransactionNotification() is a no-op: the supplied Co-op Connect docs show no REST endpoint for registering an INS callback URL. ' +
        'Confirm with Co-op (openbankingcustomersupport@co-opbank.co.ke) whether this is configured via their developer portal or requires a manual account-manager request.'
    );
    return { registered: false, reason: 'not_documented_as_an_api_call' };
  }

  normalizeTransaction(raw) {
    return mapCoopWebhookNotification(raw);
  }

  /**
   * SendTransactionINS's own schema lists "Basic" as both a header
   * parameter ("Basic Auth Endpoint Credential") AND a body field ("Basic
   * Auth Credential") — the doc doesn't disambiguate which one Co-op
   * actually sends in practice, so this checks both against
   * COOP_INS_BASIC_SECRET and accepts either.
   */
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
