import '../setup.js';
import mongoose from 'mongoose';
import { BankTransaction } from '../../src/models/BankTransaction.js';

describe('BankTransaction schema Batch 03', () => {
  test('eventType is required with no CREDIT default', () => {
    const path = BankTransaction.schema.path('eventType');
    expect(path.isRequired).toBeTruthy();
    expect(path.defaultValue).toBeUndefined();
  });

  test('unique index remains provider + providerTransactionId', () => {
    const indexes = BankTransaction.schema.indexes();
    const u = indexes.find(
      ([key, opts]) => key.provider === 1 && key.providerTransactionId === 1 && opts?.unique
    );
    expect(u).toBeTruthy();
  });

  test('rejects document without eventType at validation', () => {
    const doc = new BankTransaction({
      clientId: new mongoose.Types.ObjectId(),
      estateId: new mongoose.Types.ObjectId(),
      bankAccountId: new mongoose.Types.ObjectId(),
      provider: 'COOP',
      providerTransactionId: 'x',
      amountCents: 100,
      transactionDate: new Date(),
    });
    expect(doc.validateSync()?.errors?.eventType).toBeTruthy();
  });

  test('accepts valueDate and connectionId provenance fields', () => {
    const doc = new BankTransaction({
      clientId: new mongoose.Types.ObjectId(),
      estateId: new mongoose.Types.ObjectId(),
      bankAccountId: new mongoose.Types.ObjectId(),
      connectionId: new mongoose.Types.ObjectId(),
      provider: 'COOP',
      providerTransactionId: 'y',
      amountCents: 100,
      transactionDate: new Date(),
      valueDate: new Date(),
      eventType: 'DEBIT',
    });
    expect(doc.validateSync()).toBeUndefined();
  });
});
