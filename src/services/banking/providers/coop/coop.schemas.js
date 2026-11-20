// src/services/banking/providers/coop/coop.schemas.js
// Resource-specific request shapes for Co-op Connect 2.0.0.
// Account Validation examples include 11-digit numbers; FullStatement docs 14 chars.
// Do not impose a single global account-number length.

import { z } from 'zod';

export const CoopAccountNumber14 = z.string().length(14);

export const CoopAccountNumberValidation = z
  .string()
  .min(6)
  .max(20)
  .regex(/^[0-9A-Za-z]+$/);

export const AccountTransactionsRequest = z.object({
  MessageReference: z.string().min(1).max(27),
  AccountNumber: CoopAccountNumber14,
  // Sample serializes as string; max 500 is documented example limit.
  NoOfTransactions: z
    .string()
    .regex(/^[1-9]\d*$/)
    .refine((v) => Number(v) <= 500, { message: 'NoOfTransactions must not exceed 500' }),
});

export const AccountFullStatementRequest = z.object({
  MessageReference: z.string().min(1).max(27),
  AccountNumber: CoopAccountNumber14,
  StartDate: z.string(),
  EndDate: z.string(),
});

export const AccountValidationRequest = z.object({
  MessageReference: z.string().min(1).max(27),
  AccountNumber: CoopAccountNumberValidation,
});

export const AccountBalanceRequest = z.object({
  MessageReference: z.string().min(1).max(27),
  AccountNumber: CoopAccountNumber14,
});

export const SendTransactionINSPayload = z.object({
  MessageReference: z.string().min(1).max(27),
  MessageDateTime: z.string(),
  ServiceName: z.string().optional(),
  NotificationCode: z.string().optional(),
  CallBackUrl: z.string().optional(),
  Basic: z.string().optional(),
  PaymentRef: z.string().optional(),
  AccountNumber: z.string().max(20),
  Amount: z.union([z.string(), z.number()]),
  TransactionDate: z.string(),
  EventType: z.string(),
  BookedBalance: z.number().optional(),
  ClearedBalance: z.number().optional(),
  Currency: z.enum(['KES', 'USD', 'EUR', 'GBP', 'AUD', 'CHF', 'CAD', 'ZAR']).optional(),
  ExchangeRate: z.number().optional(),
  Narration: z.string().max(25).optional(),
  CustMemo: z
    .object({
      CustMemoLine1: z.string().optional(),
      CustMemoLine2: z.string().optional(),
      CustMemoLine3: z.string().optional(),
    })
    .optional(),
  ValueDate: z.string().optional(),
  EntryDate: z.string().optional(),
  TransactionId: z.string().optional(),
});

export function isCoopSuccess(response) {
  return response?.MessageCode === '0' || response?.MessageCode === 0;
}

export function getCoopMessageCode(response) {
  if (response == null || response.MessageCode === undefined || response.MessageCode === null) {
    return null;
  }
  return String(response.MessageCode);
}
