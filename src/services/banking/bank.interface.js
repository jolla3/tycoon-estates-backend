// src/services/banking/bank.interface.js
//
// Section 7/8/11 of the master prompt: the generic contract every bank
// provider implements. Controllers, routes, and payment/reconciliation
// services may ONLY ever call through this shape — never a provider's SDK
// or HTTP client directly.
//
// Not every bank supports every capability equally well (e.g. some banks
// have no push-notification mechanism and rely purely on polling
// AccountTransactions). Providers that can't support a capability should
// throw a clearly-labeled "not supported" error rather than silently
// no-op, so BankService can decide how to degrade gracefully.

export class BankProviderInterface {
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

  async registerTransactionNotification(_bankAccount) {
    throw new Error('registerTransactionNotification() not implemented');
  }

  /** Optional capability — not every provider supports pre-connection account validation. */
  async validateAccount(_bankAccount) {
    throw new Error('validateAccount() not implemented');
  }

  /** Converts this provider's raw payload into the app's normalized shape. */
  normalizeTransaction(_rawTransaction) {
    throw new Error('normalizeTransaction() not implemented');
  }

  /** Validates an inbound webhook request according to this bank's mechanism. */
  verifyWebhookSignature(_req) {
    throw new Error('verifyWebhookSignature() not implemented');
  }

  getProviderName() {
    throw new Error('getProviderName() not implemented');
  }
}
