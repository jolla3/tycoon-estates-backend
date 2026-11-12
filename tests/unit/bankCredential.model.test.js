import '../setup.js';
import mongoose from 'mongoose';
import { BankCredential } from '../../src/models/BankCredential.js';

const clientId = new mongoose.Types.ObjectId();

function validEnvelope(overrides = {}) {
  return {
    format: 'tycoon-bank-credential',
    formatVersion: 1,
    algorithm: 'aes-256-gcm',
    keyId: '0123456789abcdef',
    iv: '0123456789abcdef01234567',
    authTag: '0123456789abcdef0123456789abcdef',
    ciphertext: 'YWJj',
    ...overrides,
  };
}

function validCredential(overrides = {}) {
  return {
    _id: 'secrets://bank/connections/coop/client/ref-001',
    clientId,
    provider: 'COOP',
    credentialVersion: 1,
    envelope: validEnvelope(),
    ...overrides,
  };
}

describe('BankCredential model', () => {
  test('accepts a valid encrypted credential record', () => {
    const doc = new BankCredential(validCredential());

    expect(doc.validateSync()).toBeUndefined();
    expect(doc.collection.collectionName).toBe('bankcredentials');
    expect(doc._id).toBe('secrets://bank/connections/coop/client/ref-001');
  });

  test('requires reference, client, provider, version and encrypted envelope', () => {
    const missingRef = new BankCredential(validCredential({ _id: undefined }));
    expect(missingRef.validateSync()?.errors?._id).toBeTruthy();

    const missingClient = new BankCredential(validCredential({ clientId: undefined }));
    expect(missingClient.validateSync()?.errors?.clientId).toBeTruthy();

    const missingProvider = new BankCredential(validCredential({ provider: undefined }));
    expect(missingProvider.validateSync()?.errors?.provider).toBeTruthy();

    const missingVersion = new BankCredential(
      validCredential({ credentialVersion: undefined })
    );
    expect(missingVersion.validateSync()?.errors?.credentialVersion).toBeTruthy();

    const missingEnvelope = new BankCredential(
      validCredential({ envelope: undefined })
    );
    expect(missingEnvelope.validateSync()?.errors?.envelope).toBeTruthy();
  });

  test('rejects invalid providers and credential versions', () => {
    const invalidProvider = new BankCredential(
      validCredential({ provider: 'UNKNOWN' })
    );
    expect(invalidProvider.validateSync()?.errors?.provider).toBeTruthy();

    for (const credentialVersion of [0, -1, 1.5, NaN]) {
      const doc = new BankCredential(validCredential({ credentialVersion }));
      expect(doc.validateSync()?.errors?.credentialVersion).toBeTruthy();
    }

    const valid = new BankCredential(validCredential({ credentialVersion: 7 }));
    expect(valid.validateSync()).toBeUndefined();
  });

  test('accepts canonical Base64 with and without padding', () => {
    const padded = new BankCredential(validCredential({
      envelope: validEnvelope({ ciphertext: 'YWJjZA==' }),
    }));
    expect(padded.validateSync()).toBeUndefined();

    // Equivalent canonical Base64 with padding omitted.
    const unpadded = new BankCredential(validCredential({
      envelope: validEnvelope({ ciphertext: 'YWJjZA' }),
    }));
    expect(unpadded.validateSync()).toBeUndefined();

    const completeBlocks = new BankCredential(validCredential({
      envelope: validEnvelope({ ciphertext: 'YWJj' }),
    }));
    expect(completeBlocks.validateSync()).toBeUndefined();
  });

  test('rejects malformed envelope metadata and ciphertext', () => {
    const invalidKeyId = new BankCredential(validCredential({
      envelope: validEnvelope({ keyId: 'not-a-key-id' }),
    }));
    expect(invalidKeyId.validateSync()?.errors?.['envelope.keyId']).toBeTruthy();

    const invalidIv = new BankCredential(validCredential({
      envelope: validEnvelope({ iv: 'bad-iv' }),
    }));
    expect(invalidIv.validateSync()?.errors?.['envelope.iv']).toBeTruthy();

    const invalidTag = new BankCredential(validCredential({
      envelope: validEnvelope({ authTag: 'bad-tag' }),
    }));
    expect(invalidTag.validateSync()?.errors?.['envelope.authTag']).toBeTruthy();

    for (const ciphertext of ['', 'abcde', 'YWJjZA=', 'YWJj$A==']) {
      const invalidCiphertext = new BankCredential(validCredential({
        envelope: validEnvelope({ ciphertext }),
      }));
      expect(
        invalidCiphertext.validateSync()?.errors?.['envelope.ciphertext']
      ).toBeTruthy();
    }
  });

  test('uses the opaque reference as a string _id and relies on Mongo _id uniqueness', () => {
    expect(BankCredential.schema.path('_id').instance).toBe('String');
    expect(BankCredential.schema.options.collection).toBe('bankcredentials');
    expect(BankCredential.schema.options.autoIndex).toBe(false);

    // No additional credential index is declared. MongoDB supplies the
    // unique _id index automatically when the collection is created.
    expect(BankCredential.schema.indexes()).toEqual([]);
  });

  test('locks owner, provider, version and envelope against document updates', () => {
    expect(BankCredential.schema.path('clientId').options.immutable).toBe(true);
    expect(BankCredential.schema.path('provider').options.immutable).toBe(true);
    expect(BankCredential.schema.path('credentialVersion').options.immutable).toBe(true);
    expect(BankCredential.schema.path('envelope').options.immutable).toBe(true);
  });

  test('JSON serialization never exposes the reference or encrypted envelope', () => {
    const doc = new BankCredential(validCredential());
    const json = doc.toJSON();

    expect(json._id).toBeUndefined();
    expect(json.envelope).toBeUndefined();
    expect(json.clientId).toBeDefined();
    expect(json.provider).toBe('COOP');
    expect(json.credentialVersion).toBe(1);
  });
});
