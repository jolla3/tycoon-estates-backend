// src/utils/errors.js — standard application error types + codes (section 28).

export class AppError extends Error {
  constructor(code, message, status = 400) {
    super(message);
    this.name = 'AppError';
    this.code = code;
    this.status = status;
  }
}

export const Errors = {
  AuthRequired: (msg = 'Authentication required') => new AppError('AUTH_REQUIRED', msg, 401),
  InvalidCredentials: (msg = 'Invalid email or password') => new AppError('INVALID_CREDENTIALS', msg, 401),
  Forbidden: (msg = 'Not permitted') => new AppError('FORBIDDEN', msg, 403),
  EstateNotFound: (msg = 'Estate not found') => new AppError('ESTATE_NOT_FOUND', msg, 404),
  HouseNotFound: (msg = 'House not found') => new AppError('HOUSE_NOT_FOUND', msg, 404),
  HouseTypeNotFound: (msg = 'House type not found') => new AppError('HOUSE_TYPE_NOT_FOUND', msg, 404),
  TenantNotFound: (msg = 'Tenant not found') => new AppError('TENANT_NOT_FOUND', msg, 404),
  BankAccountNotFound: (msg = 'Bank account not found') => new AppError('BANK_ACCOUNT_NOT_FOUND', msg, 404),
  BankProviderUnavailable: (msg = 'Bank provider unavailable') => new AppError('BANK_PROVIDER_UNAVAILABLE', msg, 502),
  BankAuthFailed: (msg = 'Bank authentication failed') => new AppError('BANK_AUTH_FAILED', msg, 502),
  TransactionAlreadyProcessed: (msg = 'Transaction already processed') => new AppError('TRANSACTION_ALREADY_PROCESSED', msg, 409),
  TransactionUnmatched: (msg = 'Transaction could not be matched') => new AppError('TRANSACTION_UNMATCHED', msg, 422),
  PaymentNotFound: (msg = 'Payment not found') => new AppError('PAYMENT_NOT_FOUND', msg, 404),
  InvalidRequest: (msg = 'Invalid request') => new AppError('INVALID_REQUEST', msg, 422),
  RateLimited: (msg = 'Too many requests') => new AppError('RATE_LIMITED', msg, 429),
  Conflict: (msg = 'Conflict') => new AppError('CONFLICT', msg, 409),
  NotFound: (msg = 'Not found') => new AppError('NOT_FOUND', msg, 404),
};
