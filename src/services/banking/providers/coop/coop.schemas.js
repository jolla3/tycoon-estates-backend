// src/services/banking/providers/coop/coop.schemas.js
//
// Request/response shapes exactly as documented in Co-op Connect 2.0.0.
// Used both to validate outbound requests before they leave our process
// and as a single reference point for what the docs actually specify (as
// opposed to what earlier assumed-generic-REST code guessed).

import { z } from 'zod';

// AccountNumber is documented as exactly 14 characters everywhere it appears.
export const CoopAccountNumber = z.string().length(14);

export const AccountTransactionsRequest = z.object({
  MessageReference: z.string().min(1).max(27),
  AccountNumber: CoopAccountNumber,
  NoOfTransactions: z.number().int().positive(),
});

export const AccountFullStatementRequest = z.object({
  MessageReference: z.string().min(1).max(27),
  AccountNumber: CoopAccountNumber,
  StartDate: z.string(), // documented example: "2019-01-01"
  EndDate: z.string(),
});

export const AccountBalanceRequest = z.object({
  MessageReference: z.string().min(1).max(27),
  AccountNumber: CoopAccountNumber,
});

export const AccountValidationRequest = z.object({
  MessageReference: z.string().min(1).max(27),
  AccountNumber: CoopAccountNumber,
});

// SendTransactionINS request body — the one fully-specified transaction
// schema in the supplied docs. This is what we receive on our webhook.
export const SendTransactionINSPayload = z.object({
  MessageReference: z.string().min(1).max(27),
  MessageDateTime: z.string(),
  ServiceName: z.string().optional(),
  NotificationCode: z.string().optional(),
  CallBackUrl: z.string().optional(),
  Basic: z.string().optional(), // Basic Auth Credential — see coop.provider.js#verifyWebhookSignature
  PaymentRef: z.string().optional(),
  AccountNumber: z.string().max(14),
  Amount: z.union([z.string(), z.number()]),
  TransactionDate: z.string(), // documented format: "20190301165420" (YYYYMMDDHHmmss)
  EventType: z.string(), // documented values seen: "DEBIT" / (implied) "CREDIT"
  BookedBalance: z.number().optional(),
  ClearedBalance: z.number().optional(),
  Currency: z.enum(['KES', 'USD', 'EUR', 'GBP', 'AUD', 'CHF', 'CAD', 'ZAR']).optional(),
  ExchangeRate: z.number().optional(),
  Narration: z.string().max(25).optional(),
  CustMemo: z.object({ CustMemoLine1: z.string().optional(), CustMemoLine2: z.string().optional(), CustMemoLine3: z.string().optional() }).optional(),
  ValueDate: z.string().optional(), // "20190301" (YYYYMMDD)
  EntryDate: z.string().optional(),
  TransactionId: z.string().optional(),
});

/** MessageCode "0" == success across every documented response in this API. Everything else is an error — MessageDescription carries the reason. */
export function isCoopSuccess(response) {
  return response?.MessageCode === '0' || response?.MessageCode === 0;
}
