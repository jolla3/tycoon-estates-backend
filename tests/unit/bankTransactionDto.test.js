import mongoose from 'mongoose';
import { BankTransaction } from '../../src/models/BankTransaction.js';
import { toBankTransactionDTO, BANK_TRANSACTION_DTO_FIELDS } from '../../src/utils/bankTransactionDto.js';

const FORBIDDEN = [
  'rawPayload', 'processingClaimToken', 'processingClaimExpiresAt', 'processingAttempts',
  'lastProcessingError', 'rawReference', 'connectionId', 'bookedBalanceCents',
  'clearedBalanceCents', 'schemaUnverified', 'sourceChannel',
];
const id = () => new mongoose.Types.ObjectId();

function fullDoc() {
  return new BankTransaction({
    clientId: id(), estateId: id(), bankAccountId: id(), connectionId: id(),
    provider: 'COOP', providerTransactionId: 'T1', amountCents: 1000, eventType: 'CREDIT',
    transactionDate: new Date('2026-01-05'), paymentReference: 'REF', narration: 'rent',
    rawReference: 'raw', bookedBalanceCents: 5, clearedBalanceCents: 6,
    processingClaimToken: 'SECRET-TOKEN', processingClaimExpiresAt: new Date(),
    processingAttempts: 3, lastProcessingError: 'boom', rawPayload: { account: '123', secret: 'x' },
  });
}

describe('toBankTransactionDTO', () => {
  test('serialized JSON of a Mongoose document contains no internal field', () => {
    const json = JSON.parse(JSON.stringify(toBankTransactionDTO(fullDoc())));
    for (const k of FORBIDDEN) expect(Object.keys(json)).not.toContain(k);
    expect(JSON.stringify(json)).not.toMatch(/SECRET-TOKEN|boom/);
    expect(json.amountCents).toBe(1000);
    expect(json.matchStatus).toBe('UNMATCHED');
  });
  test('works on lean plain objects', () => {
    const plain = { ...fullDoc().toObject(), extraNewField: 'private by default' };
    const out = toBankTransactionDTO(plain);
    expect(out.extraNewField).toBeUndefined();
    expect(out.rawPayload).toBeUndefined();
  });
  test('allowlist never names a forbidden key', () => {
    for (const k of FORBIDDEN) expect(BANK_TRANSACTION_DTO_FIELDS).not.toContain(k);
  });
  test('null/undefined pass through', () => {
    expect(toBankTransactionDTO(null)).toBeNull();
  });
});
