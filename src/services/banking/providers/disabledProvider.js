// src/services/banking/providers/disabledProvider.js
//
// Base for reserved providers without a verified operational contract.
// Never returns fabricated success, empty mock accounts, or fake transactions.

import { BankProviderInterface } from '../bank.interface.js';
import { Errors } from '../../../utils/errors.js';

export class DisabledBankProvider extends BankProviderInterface {
  constructor(providerName, reason) {
    super();
    this.providerName = String(providerName).toUpperCase();
    this.reason = reason || `Provider ${providerName} has no verified operational API contract in this workspace`;
  }

  getProviderName() {
    return this.providerName;
  }

  _unsupported(capability) {
    throw Errors.BankCapabilityUnsupported(
      `${this.providerName}: ${capability} is not operational — ${this.reason}`
    );
  }

  async authenticate() {
    this._unsupported('authenticate');
  }

  async getTransactions() {
    this._unsupported('getTransactions');
  }

  async getFullStatement() {
    this._unsupported('getFullStatement');
  }

  async getAccountBalance() {
    this._unsupported('getAccountBalance');
  }

  async validateAccount() {
    this._unsupported('validateAccount');
  }

  async registerTransactionNotification() {
    this._unsupported('registerTransactionNotification');
  }

  normalizeTransaction() {
    this._unsupported('normalizeTransaction');
  }

  verifyWebhookSignature() {
    this._unsupported('verifyWebhookSignature');
  }
}
