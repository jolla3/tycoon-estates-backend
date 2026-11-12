// src/services/banking/bank.interface.js
//
// Bank-neutral adapter contract. Shared services call only through this
// shape — never a provider SDK or HTTP client directly.
//
// Unsupported capabilities MUST throw a clearly labeled error (not silent
// no-op) so callers can fail closed or degrade deliberately.

export class BankProviderInterface {
  /** Acquire or return a connection-scoped access token. */
  async authenticate() {
    throw new Error('authenticate() not implemented');
  }

  async getTransactions(_bankAccount, _options) {
    throw new Error('getTransactions() not implemented');
  }

  async getFullStatement(_bankAccount, _startDate, _endDate) {
    throw new Error('getFullStatement() not implemented');
  }

  async getAccountBalance(_bankAccount) {
    throw new Error('getAccountBalance() not implemented');
  }

  /**
   * Provider-specific account validation / ownership check used at onboarding.
   * MUST reject when the account cannot be validated.
   */
  async validateAccount(_bankAccount) {
    throw new Error('validateAccount() not implemented');
  }

  async registerTransactionNotification(_bankAccount) {
    throw new Error('registerTransactionNotification() not implemented');
  }

  /** Normalize a provider-specific raw transaction into the shared shape. */
  normalizeTransaction(_rawTransaction) {
    throw new Error('normalizeTransaction() not implemented');
  }

  /** Validate an inbound webhook request according to this provider's mechanism. */
  verifyWebhookSignature(_req) {
    throw new Error('verifyWebhookSignature() not implemented');
  }

  getProviderName() {
    throw new Error('getProviderName() not implemented');
  }
}
