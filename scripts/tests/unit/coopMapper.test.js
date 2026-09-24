import '../setup.js';
import { mapCoopWebhookNotification, mapCoopPolledTransaction } from '../../src/services/banking/providers/coop/coop.mapper.js';

describe('mapCoopWebhookNotification (CONFIRMED field names — SendTransactionINS is fully specified in the supplied docs)', () => {
  test('maps a documented SendTransactionINS payload into the normalized shape', () => {
    const raw = {
      TransactionId: 'TXN123',
      PaymentRef: 'A12',
      AccountNumber: '00112233445566',
      Amount: 15000,
      TransactionDate: '20260831100000', // Co-op's documented compact format, not ISO
      Narration: 'Rent payment A12',
      EventType: 'credit',
      Currency: 'KES',
      BookedBalance: 5000,
      ClearedBalance: 4900,
    };

    const normalized = mapCoopWebhookNotification(raw);

    expect(normalized).toMatchObject({
      provider: 'COOP',
      providerTransactionId: 'TXN123',
      accountNumber: '00112233445566',
      amountCents: 1500000,
      currency: 'KES',
      paymentReference: 'A12',
      narration: 'Rent payment A12',
      eventType: 'CREDIT', // uppercased regardless of Co-op's casing
      bookedBalanceCents: 500000,
      clearedBalanceCents: 490000,
    });
    expect(normalized.transactionDate).toBeInstanceOf(Date);
    expect(normalized.transactionDate.toISOString()).toBe('2026-08-31T10:00:00.000Z');
  });

  test('parses the YYYYMMDD ValueDate/EntryDate format too', () => {
    const normalized = mapCoopWebhookNotification({ TransactionId: 'T1', Amount: 100, TransactionDate: '20260101000000', ValueDate: '20260101' });
    expect(normalized.valueDate.toISOString()).toBe('2026-01-01T00:00:00.000Z');
  });

  test('defaults currency to KES and tolerates a missing EventType', () => {
    const normalized = mapCoopWebhookNotification({ TransactionId: 'TXN999', Amount: 500, TransactionDate: '20260101000000' });
    expect(normalized.currency).toBe('KES');
    expect(normalized.eventType).toBe('');
  });
});

describe('mapCoopPolledTransaction (UNVERIFIED — the docs never expanded this item schema)', () => {
  test('is explicitly flagged as unverified so callers cannot mistake it for confirmed', () => {
    const normalized = mapCoopPolledTransaction({ TransactionId: 'X', Amount: 100 });
    expect(normalized._unverifiedSchema).toBe(true);
    expect(normalized.rawPayload).toBeDefined();
  });
});
