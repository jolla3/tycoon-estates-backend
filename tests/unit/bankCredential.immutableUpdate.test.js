import '../setup.js';
import mongoose from 'mongoose';
import { BankCredential } from '../../src/models/BankCredential.js';

describe('BankCredential immutable envelope update contract', () => {
  const oldEnvelope = {
    format: 'tycoon-bank-credential',
    formatVersion: 1,
    algorithm: 'aes-256-gcm',
    keyId: '1111111111111111',
    iv: '111111111111111111111111',
    authTag: '11111111111111111111111111111111',
    ciphertext: 'YQ==',
  };

  const nextEnvelope = {
    ...oldEnvelope,
    keyId: '2222222222222222',
    iv: '222222222222222222222222',
    authTag: '22222222222222222222222222222222',
    ciphertext: 'Yg==',
  };

  const filter = {
    _id: 'secrets://bank/connections/coop/client/rewrap-probe',
    clientId: '64b000000000000000000001',
    provider: 'COOP',
    credentialVersion: 1,
    'envelope.format': oldEnvelope.format,
    'envelope.formatVersion': oldEnvelope.formatVersion,
    'envelope.algorithm': oldEnvelope.algorithm,
    'envelope.keyId': oldEnvelope.keyId,
    'envelope.iv': oldEnvelope.iv,
    'envelope.authTag': oldEnvelope.authTag,
    'envelope.ciphertext': oldEnvelope.ciphertext,
  };

  test('ordinary updates cannot replace the immutable envelope', () => {
    expect(
      BankCredential.schema.path('envelope').options.immutable
    ).toBe(true);

    const query = BankCredential.updateOne(
      filter,
      { $set: { envelope: nextEnvelope } },
      { runValidators: true, strict: 'throw' }
    );

    expect(() => query._castUpdate(query.getUpdate()))
      .toThrow(/immutable/i);
  });

  test('controlled key rewrap retains the envelope and compare-and-swap filter', () => {
    const query = BankCredential.updateOne(
      filter,
      { $set: { envelope: nextEnvelope } },
      {
        overwriteImmutable: true,
        runValidators: true,
        strict: 'throw',
        timestamps: false,
      }
    );

    // This intentionally tests Mongoose's update-casting behavior. It does
    // not execute the query or connect to MongoDB.
    const castUpdate = query._castUpdate(query.getUpdate());

    expect(castUpdate.$set.envelope).toMatchObject(nextEnvelope);
    expect(castUpdate.$set.envelope.toObject()).toEqual(nextEnvelope);

    expect(query.getFilter()).toMatchObject({
      _id: filter._id,
      clientId: filter.clientId,
      provider: filter.provider,
      credentialVersion: filter.credentialVersion,
      'envelope.keyId': oldEnvelope.keyId,
      'envelope.iv': oldEnvelope.iv,
      'envelope.authTag': oldEnvelope.authTag,
      'envelope.ciphertext': oldEnvelope.ciphertext,
    });

    expect(query.getOptions()).toMatchObject({
      runValidators: true,
      strict: 'throw',
    });

    // This model only timestamps creation. Envelope rotation must not
    // manufacture or update an updatedAt field.
    expect(BankCredential.schema.options.timestamps).toMatchObject({
      createdAt: true,
      updatedAt: false,
    });
    expect(castUpdate.$set.updatedAt).toBeUndefined();
  });
});
