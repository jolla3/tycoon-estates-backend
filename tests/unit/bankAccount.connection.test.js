import '../setup.js';
import mongoose from 'mongoose';
import { BankAccount } from '../../src/models/BankAccount.js';
import {
  BANK_CONNECTION_PROVIDERS,
} from '../../src/models/BankConnection.js';

describe('BankAccount connection association (schema)', () => {
  test('accepts connectionId, validationStatus, and entitlements', () => {
    const doc = new BankAccount({
      clientId: new mongoose.Types.ObjectId(),
      estateId: new mongoose.Types.ObjectId(),
      connectionId: new mongoose.Types.ObjectId(),
      provider: 'COOP',
      accountNumberEncrypted: 'iv:tag:data',
      accountNumberHash: 'abc',
      accountName: 'Ops',
      validationStatus: 'validated',
      entitlements: { poll: true, statement: true, balance: true, webhookIngest: false },
    });
    expect(doc.validateSync()).toBeUndefined();
    expect(doc.connectionId).toBeTruthy();
    expect(doc.entitlements.poll).toBe(true);
  });

  test('allows legacy rows without connectionId', () => {
    const doc = new BankAccount({
      clientId: new mongoose.Types.ObjectId(),
      estateId: new mongoose.Types.ObjectId(),
      provider: 'COOP',
      accountNumberEncrypted: 'iv:tag:data',
      accountNumberHash: 'legacy',
      accountName: 'Legacy',
    });
    expect(doc.validateSync()).toBeUndefined();
    expect(doc.connectionId == null).toBe(true);
  });

  test('rejects invalid validationStatus', () => {
    const doc = new BankAccount({
      clientId: new mongoose.Types.ObjectId(),
      estateId: new mongoose.Types.ObjectId(),
      provider: 'COOP',
      accountNumberEncrypted: 'x',
      accountNumberHash: 'h',
      accountName: 'n',
      validationStatus: 'connected',
    });
    expect(doc.validateSync()?.errors?.validationStatus).toBeTruthy();
  });

  test('provider identifiers remain the reserved set', () => {
    expect(BANK_CONNECTION_PROVIDERS).toEqual(['COOP', 'KCB', 'EQUITY', 'NCBA']);
  });

  test('physical identity unique index is declared on provider + accountNumberHash', () => {
    const indexes = BankAccount.schema.indexes();
    const physical = indexes.find(
      ([key, opts]) => key.provider === 1 && key.accountNumberHash === 1 && opts?.unique === true
    );
    expect(physical).toBeTruthy();
  });
});
