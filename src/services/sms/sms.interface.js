// src/services/sms/sms.interface.js
//
// Section 17: SmsProvider contract. Mirrors the BankProvider pattern —
// nothing outside this interface + its providers should know Celcom's (or
// any future provider's) request/response shape.

export class SmsProviderInterface {
  async send(_phone, _message, _idempotencyKey) {
    throw new Error('send() not implemented');
  }

  async checkBalance() {
    throw new Error('checkBalance() not implemented');
  }

  async healthCheck() {
    throw new Error('healthCheck() not implemented');
  }

  getProviderName() {
    throw new Error('getProviderName() not implemented');
  }
}
