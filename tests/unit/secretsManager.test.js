import { jest } from '@jest/globals';
import '../setup.js';

const CLIENT_A = '64b000000000000000000001';
const CLIENT_B = '64b000000000000000000002';

const createCredential = jest.fn();
const findCredential = jest.fn();
const deleteCredential = jest.fn();
const updateCredential = jest.fn();

jest.unstable_mockModule('../../src/models/BankCredential.js', () => ({
  BankCredential: {
    create: createCredential,
    findOne: findCredential,
    updateOne: updateCredential,
    deleteOne: deleteCredential,
  },
}));

const {
  allocateCredentialsRef,
  putConnectionSecret,
  importConnectionSecret,
  getConnectionSecret,
  rewrapConnectionSecret,
  secretsManager,
  deleteConnectionSecret,
  assertBankCredentialEncryptionConfigured,
} = await import('../../src/services/banking/secretsManager.js');

let stored;
const records = new Map();

function valueAtPath(object, path) {
  return path.split('.').reduce(
    (value, key) => value == null ? undefined : value[key],
    object
  );
}

function matchesFilter(row, filter) {
  return Boolean(row) && Object.entries(filter).every(
    ([key, value]) => String(valueAtPath(row, key)) === String(value)
  );
}

describe('MongoDB bank credential secrets manager', () => {
  test('exposes legacy import through the aggregate secrets manager API', () => {
    expect(secretsManager.importConnectionSecret).toBe(importConnectionSecret);
  });

  beforeEach(() => {
    jest.clearAllMocks();
    stored = null;
    records.clear();
    process.env.BANK_SECRETS_ENCRYPTION_KEY = '11'.repeat(32);
    delete process.env.BANK_SECRETS_ENCRYPTION_KEY_PREVIOUS;

    createCredential.mockImplementation(async (record) => {
      const ref = String(record._id);

      if (records.has(ref)) {
        const error = new Error('simulated MongoDB duplicate key');
        error.code = 11000;
        throw error;
      }

      stored = structuredClone(record);
      records.set(stored._id, stored);
      return record;
    });

    findCredential.mockImplementation((filter) => ({
      lean: async () => {
        const row = records.get(String(filter._id));
        return matchesFilter(row, filter) ? structuredClone(row) : null;
      },
    }));

    updateCredential.mockImplementation(async (filter, update) => {
      const row = records.get(String(filter._id));
      if (!matchesFilter(row, filter)) {
        return { acknowledged: true, matchedCount: 0, modifiedCount: 0 };
      }

      const next = {
        ...structuredClone(row),
        envelope: structuredClone(update.$set.envelope),
      };
      records.set(String(filter._id), next);

      if (stored?._id === String(filter._id)) {
        stored = structuredClone(next);
      }

      return { acknowledged: true, matchedCount: 1, modifiedCount: 1 };
    });

    deleteCredential.mockImplementation(async (filter) => {
      const row = records.get(String(filter._id));
      if (!matchesFilter(row, filter)) return { acknowledged: true, deletedCount: 0 };
      records.delete(String(filter._id));
      if (stored?._id === String(filter._id)) stored = null;
      return { acknowledged: true, deletedCount: 1 };
    });
  });

  test('allocates opaque references and stores only an encrypted Mongo envelope', async () => {
    const ref = allocateCredentialsRef(CLIENT_A, 'COOP');
    const material = {
      clientId: 'coop-client-id',
      clientSecret: 'must-not-appear-in-mongo',
      username: 'bank-user',
      password: 'bank-password',
    };

    await putConnectionSecret(ref, material, {
      clientId: CLIENT_A,
      provider: 'COOP',
      credentialVersion: 3,
    });

    expect(createCredential).toHaveBeenCalledTimes(1);
    expect(stored).toMatchObject({
      _id: ref,
      clientId: CLIENT_A,
      provider: 'COOP',
      credentialVersion: 3,
      envelope: {
        format: 'tycoon-bank-credential',
        formatVersion: 1,
        algorithm: 'aes-256-gcm',
      },
    });
    expect(stored.envelope.iv).toMatch(/^[0-9a-f]{24}$/);
    expect(stored.envelope.authTag).toMatch(/^[0-9a-f]{32}$/);
    expect(stored.envelope.keyId).toMatch(/^[0-9a-f]{16}$/);
    expect(JSON.stringify(stored)).not.toContain(material.clientSecret);
    expect(JSON.stringify(stored)).not.toContain(material.password);

    await expect(
      getConnectionSecret(ref, {
        clientId: CLIENT_A,
        provider: 'COOP',
        expectedVersion: 3,
      })
    ).resolves.toEqual(material);
  });

  test('imports legacy material under the same reference and verifies the encrypted Mongo record', async () => {
    const ref = 'secrets://bank/connections/coop/legacy-import-001';
    const material = {
      clientId: 'legacy-coop-client',
      clientSecret: 'legacy-import-secret',
      username: 'legacy-user',
      password: 'legacy-password',
    };

    await expect(
      importConnectionSecret(ref, material, {
        clientId: CLIENT_A,
        provider: 'COOP',
        credentialVersion: 6,
      })
    ).resolves.toEqual({ status: 'imported' });

    expect(createCredential).toHaveBeenCalledTimes(1);
    expect(stored).toMatchObject({
      _id: ref,
      clientId: CLIENT_A,
      provider: 'COOP',
      credentialVersion: 6,
      envelope: {
        format: 'tycoon-bank-credential',
        formatVersion: 1,
        algorithm: 'aes-256-gcm',
      },
    });

    expect(JSON.stringify(stored)).not.toContain(material.clientSecret);
    expect(JSON.stringify(stored)).not.toContain(material.password);
    expect(findCredential).toHaveBeenCalledWith({ _id: ref });
    expect(updateCredential).not.toHaveBeenCalled();
    expect(deleteCredential).not.toHaveBeenCalled();

    await expect(
      getConnectionSecret(ref, {
        clientId: CLIENT_A,
        provider: 'COOP',
        expectedVersion: 6,
      })
    ).resolves.toEqual(material);
  });

  test('makes an exact repeated import idempotent without replacing the envelope', async () => {
    const ref = 'secrets://bank/connections/coop/legacy-import-repeat';
    const material = { clientSecret: 'same-material' };

    await expect(
      importConnectionSecret(ref, material, {
        clientId: CLIENT_A,
        provider: 'COOP',
        credentialVersion: 2,
      })
    ).resolves.toEqual({ status: 'imported' });

    const original = structuredClone(records.get(ref));

    await expect(
      importConnectionSecret(ref, material, {
        clientId: CLIENT_A,
        provider: 'COOP',
        credentialVersion: 2,
      })
    ).resolves.toEqual({ status: 'already_present' });

    expect(createCredential).toHaveBeenCalledTimes(2);
    expect(records.get(ref)).toEqual(original);
    expect(updateCredential).not.toHaveBeenCalled();
    expect(deleteCredential).not.toHaveBeenCalled();
  });

  test('refuses a reference already owned by a different client', async () => {
    const ref = 'secrets://bank/connections/coop/legacy-import-owner-collision';

    await importConnectionSecret(ref, { password: 'owner-a' }, {
      clientId: CLIENT_A,
      provider: 'COOP',
      credentialVersion: 1,
    });

    const original = structuredClone(records.get(ref));

    await expect(
      importConnectionSecret(ref, { password: 'owner-b' }, {
        clientId: CLIENT_B,
        provider: 'COOP',
        credentialVersion: 1,
      })
    ).rejects.toThrow(/different credential record/i);

    expect(records.get(ref)).toEqual(original);
    expect(updateCredential).not.toHaveBeenCalled();
    expect(deleteCredential).not.toHaveBeenCalled();
  });

  test('refuses a reference already bound to a different provider', async () => {
    const ref = 'secrets://bank/connections/coop/legacy-import-provider-collision';

    await importConnectionSecret(ref, { password: 'provider-owner' }, {
      clientId: CLIENT_A,
      provider: 'COOP',
      credentialVersion: 1,
    });

    const original = structuredClone(records.get(ref));

    await expect(
      importConnectionSecret(ref, { password: 'provider-owner' }, {
        clientId: CLIENT_A,
        provider: 'KCB',
        credentialVersion: 1,
      })
    ).rejects.toThrow(/different credential record/i);

    expect(records.get(ref)).toEqual(original);
    expect(updateCredential).not.toHaveBeenCalled();
    expect(deleteCredential).not.toHaveBeenCalled();
  });

  test('refuses a reference already bound to a different credential version', async () => {
    const ref = 'secrets://bank/connections/coop/legacy-import-version-collision';
    const material = { password: 'version-owner' };

    await importConnectionSecret(ref, material, {
      clientId: CLIENT_A,
      provider: 'COOP',
      credentialVersion: 1,
    });

    const original = structuredClone(records.get(ref));

    await expect(
      importConnectionSecret(ref, material, {
        clientId: CLIENT_A,
        provider: 'COOP',
        credentialVersion: 2,
      })
    ).rejects.toThrow(/different credential record/i);

    expect(records.get(ref)).toEqual(original);
    expect(updateCredential).not.toHaveBeenCalled();
    expect(deleteCredential).not.toHaveBeenCalled();
  });

  test('canonicalizes uppercase ObjectId input for credential encryption and lookup', async () => {
    const ref = 'secrets://bank/connections/coop/legacy-import-uppercase-owner';
    const material = { password: 'canonical-owner' };

    await expect(
      importConnectionSecret(ref, material, {
        clientId: CLIENT_A.toUpperCase(),
        provider: 'coop',
        credentialVersion: 1,
      })
    ).resolves.toEqual({ status: 'imported' });

    expect(records.get(ref).clientId).toBe(CLIENT_A);

    await expect(
      getConnectionSecret(ref, {
        clientId: CLIENT_A.toUpperCase(),
        provider: 'COOP',
        expectedVersion: 1,
      })
    ).resolves.toEqual(material);
  });

  test('refuses an existing reference containing different material', async () => {
    const ref = 'secrets://bank/connections/coop/legacy-import-material-collision';

    await importConnectionSecret(ref, { password: 'original' }, {
      clientId: CLIENT_A,
      provider: 'COOP',
      credentialVersion: 3,
    });

    const original = structuredClone(records.get(ref));

    await expect(
      importConnectionSecret(ref, { password: 'different' }, {
        clientId: CLIENT_A,
        provider: 'COOP',
        credentialVersion: 3,
      })
    ).rejects.toThrow(/different credential material/i);

    expect(records.get(ref)).toEqual(original);
    expect(updateCredential).not.toHaveBeenCalled();
    expect(deleteCredential).not.toHaveBeenCalled();
  });

  test('recognizes a committed import whose create acknowledgement was lost', async () => {
    const ref = 'secrets://bank/connections/coop/legacy-import-lost-ack';
    const material = { password: 'committed-before-ack-loss' };

    createCredential.mockImplementationOnce(async (record) => {
      stored = structuredClone(record);
      records.set(stored._id, stored);
      throw new Error('simulated lost create acknowledgement');
    });

    await expect(
      importConnectionSecret(ref, material, {
        clientId: CLIENT_A,
        provider: 'COOP',
        credentialVersion: 4,
      })
    ).resolves.toEqual({ status: 'already_present' });

    await expect(
      getConnectionSecret(ref, {
        clientId: CLIENT_A,
        provider: 'COOP',
        expectedVersion: 4,
      })
    ).resolves.toEqual(material);
  });

  test('does not claim success when a failed create has no verifiable record', async () => {
    const ref = 'secrets://bank/connections/coop/legacy-import-uncertain';

    createCredential.mockRejectedValueOnce(
      new Error('simulated connection failure before commit')
    );

    await expect(
      importConnectionSecret(ref, { password: 'uncertain' }, {
        clientId: CLIENT_A,
        provider: 'COOP',
        credentialVersion: 1,
      })
    ).rejects.toThrow(/outcome is uncertain/i);

    expect(records.has(ref)).toBe(false);
    expect(updateCredential).not.toHaveBeenCalled();
    expect(deleteCredential).not.toHaveBeenCalled();
  });

  test('rejects a persisted import whose encrypted read-back is corrupted', async () => {
    const ref = 'secrets://bank/connections/coop/legacy-import-corrupt-readback';

    createCredential.mockImplementationOnce(async (record) => {
      stored = structuredClone(record);
      stored.envelope.authTag = '00'.repeat(16);
      records.set(stored._id, structuredClone(stored));
      return record;
    });

    await expect(
      importConnectionSecret(ref, { password: 'read-back-check' }, {
        clientId: CLIENT_A,
        provider: 'COOP',
        credentialVersion: 5,
      })
    ).rejects.toThrow(/integrity verification/i);

    expect(records.has(ref)).toBe(true);
    expect(updateCredential).not.toHaveBeenCalled();
    expect(deleteCredential).not.toHaveBeenCalled();
  });

  test('rejects invalid import ownership or version before writing', async () => {
    const ref = 'secrets://bank/connections/coop/legacy-import-invalid';

    await expect(
      importConnectionSecret(ref, { password: 'invalid-owner' }, {
        clientId: 'not-an-object-id',
        provider: 'COOP',
        credentialVersion: 1,
      })
    ).rejects.toThrow(/clientId/i);

    await expect(
      importConnectionSecret(ref, { password: 'invalid-version' }, {
        clientId: CLIENT_A,
        provider: 'COOP',
        credentialVersion: 0,
      })
    ).rejects.toThrow(/credentialVersion/i);

    expect(createCredential).not.toHaveBeenCalled();
    expect(findCredential).not.toHaveBeenCalled();
  });

  test('returns a defensive decrypted object copy', async () => {
    const ref = allocateCredentialsRef(CLIENT_A, 'COOP');
    await putConnectionSecret(ref, { clientSecret: 'original' }, {
      clientId: CLIENT_A,
      provider: 'COOP',
      credentialVersion: 1,
    });

    const first = await getConnectionSecret(ref, {
      clientId: CLIENT_A,
      provider: 'COOP',
      expectedVersion: 1,
    });
    first.clientSecret = 'mutated';

    await expect(
      getConnectionSecret(ref, {
        clientId: CLIENT_A,
        provider: 'COOP',
        expectedVersion: 1,
      })
    ).resolves.toEqual({ clientSecret: 'original' });
  });

  test('scopes reads to the exact reference, client and provider', async () => {
    const ref = allocateCredentialsRef(CLIENT_A, 'COOP');
    await putConnectionSecret(ref, { password: 'owner-a' }, {
      clientId: CLIENT_A,
      provider: 'COOP',
      credentialVersion: 1,
    });

    await expect(
      getConnectionSecret(ref, {
        clientId: CLIENT_B,
        provider: 'COOP',
        expectedVersion: 1,
      })
    ).rejects.toThrow(/not found/i);

    expect(findCredential).toHaveBeenLastCalledWith({
      _id: ref,
      clientId: CLIENT_B,
      provider: 'COOP',
    });
  });

  test('rejects ciphertext copied to a different owner context', async () => {
    const ref = allocateCredentialsRef(CLIENT_A, 'COOP');
    await putConnectionSecret(ref, { password: 'owner-bound-secret' }, {
      clientId: CLIENT_A,
      provider: 'COOP',
      credentialVersion: 1,
    });

    // Simulate a database record whose owner metadata was altered while the
    // encrypted envelope was copied unchanged.
    stored.clientId = CLIENT_B;

    await expect(
      getConnectionSecret(ref, {
        clientId: CLIENT_B,
        provider: 'COOP',
        expectedVersion: 1,
      })
    ).rejects.toThrow(/integrity/i);
  });

  test('rejects ciphertext tampering', async () => {
    const ref = allocateCredentialsRef(CLIENT_A, 'COOP');
    await putConnectionSecret(ref, { password: 'tamper-test' }, {
      clientId: CLIENT_A,
      provider: 'COOP',
      credentialVersion: 1,
    });

    const bytes = Buffer.from(stored.envelope.ciphertext, 'base64');
    bytes[0] ^= 1;
    stored.envelope.ciphertext = bytes.toString('base64');

    await expect(
      getConnectionSecret(ref, {
        clientId: CLIENT_A,
        provider: 'COOP',
        expectedVersion: 1,
      })
    ).rejects.toThrow(/integrity/i);
  });

  test('rejects missing, invalid or stale credential versions', async () => {
    const ref = allocateCredentialsRef(CLIENT_A, 'COOP');
    await putConnectionSecret(ref, { password: 'versioned' }, {
      clientId: CLIENT_A,
      provider: 'COOP',
      credentialVersion: 4,
    });

    await expect(
      getConnectionSecret(ref, {
        clientId: CLIENT_A,
        provider: 'COOP',
        expectedVersion: 3,
      })
    ).rejects.toThrow(/version/i);

    await expect(
      getConnectionSecret(ref, {
        clientId: CLIENT_A,
        provider: 'COOP',
      })
    ).rejects.toThrow(/expectedVersion/i);
  });

  test('deletes only the matching owner, provider and credential version', async () => {
    const ref = allocateCredentialsRef(CLIENT_A, 'COOP');
    await putConnectionSecret(ref, { password: 'delete-test' }, {
      clientId: CLIENT_A,
      provider: 'COOP',
      credentialVersion: 2,
    });

    await deleteConnectionSecret(ref, {
      clientId: CLIENT_B,
      provider: 'COOP',
      expectedVersion: 2,
    });
    expect(stored).not.toBeNull();

    await deleteConnectionSecret(ref, {
      clientId: CLIENT_A,
      provider: 'COOP',
      expectedVersion: 1,
    });
    expect(stored).not.toBeNull();

    await deleteConnectionSecret(ref, {
      clientId: CLIENT_A,
      provider: 'COOP',
      expectedVersion: 2,
    });
    expect(stored).toBeNull();
  });

  test('rejects invalid owner context before querying MongoDB', async () => {
    const ref = 'secrets://invalid-owner';
    await expect(
      putConnectionSecret(ref, { password: 'x' }, {
        clientId: 'not-an-object-id',
        provider: 'COOP',
        credentialVersion: 1,
      })
    ).rejects.toThrow(/clientId/i);

    expect(createCredential).not.toHaveBeenCalled();
  });

  test('uses the previous key only for decryption during key rotation', async () => {
    const ref = allocateCredentialsRef(CLIENT_A, 'COOP');
    await putConnectionSecret(ref, { password: 'old-key-record' }, {
      clientId: CLIENT_A,
      provider: 'COOP',
      credentialVersion: 1,
    });

    process.env.BANK_SECRETS_ENCRYPTION_KEY = '22'.repeat(32);
    process.env.BANK_SECRETS_ENCRYPTION_KEY_PREVIOUS = '11'.repeat(32);

    await expect(
      getConnectionSecret(ref, {
        clientId: CLIENT_A,
        provider: 'COOP',
        expectedVersion: 1,
      })
    ).resolves.toEqual({ password: 'old-key-record' });

    const nextRef = allocateCredentialsRef(CLIENT_A, 'COOP');
    await putConnectionSecret(nextRef, { password: 'new-key-record' }, {
      clientId: CLIENT_A,
      provider: 'COOP',
      credentialVersion: 2,
    });

    const crypto = await import('node:crypto');
    const expectedKeyId = crypto.createHash('sha256')
      .update(Buffer.from('22'.repeat(32), 'hex'))
      .digest('hex')
      .slice(0, 16);

    expect(stored.envelope.keyId).toBe(expectedKeyId);

    delete process.env.BANK_SECRETS_ENCRYPTION_KEY_PREVIOUS;
    await expect(
      getConnectionSecret(ref, {
        clientId: CLIENT_A,
        provider: 'COOP',
        expectedVersion: 1,
      })
    ).rejects.toThrow(/key.*not configured/i);
  });

  test('startup validation requires a valid dedicated encryption key', () => {
    process.env.BANK_SECRETS_ENCRYPTION_KEY = '';
    expect(() => assertBankCredentialEncryptionConfigured())
      .toThrow(/BANK_SECRETS_ENCRYPTION_KEY/);

    process.env.BANK_SECRETS_ENCRYPTION_KEY = 'invalid';
    expect(() => assertBankCredentialEncryptionConfigured())
      .toThrow(/64 hexadecimal characters/);

    process.env.BANK_SECRETS_ENCRYPTION_KEY = '11'.repeat(32);
    process.env.BANK_SECRETS_ENCRYPTION_KEY_PREVIOUS = 'invalid';
    expect(() => assertBankCredentialEncryptionConfigured())
      .toThrow(/BANK_SECRETS_ENCRYPTION_KEY_PREVIOUS/);
  });

  test('rewraps a previous-key record under the current key without changing identity or plaintext', async () => {
    const ref = allocateCredentialsRef(CLIENT_A, 'COOP');
    const material = {
      clientSecret: 'preserve-this-material',
      password: 'preserve-this-password',
    };

    await putConnectionSecret(ref, material, {
      clientId: CLIENT_A,
      provider: 'COOP',
      credentialVersion: 7,
    });

    const before = structuredClone(records.get(ref));

    process.env.BANK_SECRETS_ENCRYPTION_KEY = '22'.repeat(32);
    process.env.BANK_SECRETS_ENCRYPTION_KEY_PREVIOUS = '11'.repeat(32);

    await expect(
      rewrapConnectionSecret(ref, {
        clientId: CLIENT_A,
        provider: 'COOP',
        expectedVersion: 7,
      })
    ).resolves.toEqual({ status: 'rotated' });

    const after = records.get(ref);
    const crypto = await import('node:crypto');
    const currentKeyId = crypto.createHash('sha256')
      .update(Buffer.from('22'.repeat(32), 'hex'))
      .digest('hex')
      .slice(0, 16);

    expect(after._id).toBe(before._id);
    expect(String(after.clientId)).toBe(String(before.clientId));
    expect(after.provider).toBe(before.provider);
    expect(after.credentialVersion).toBe(before.credentialVersion);
    expect(after.envelope.keyId).toBe(currentKeyId);
    expect(after.envelope.iv).not.toBe(before.envelope.iv);
    expect(after.envelope.ciphertext).not.toBe(before.envelope.ciphertext);

    expect(updateCredential).toHaveBeenCalledTimes(1);
    expect(updateCredential.mock.calls[0][2]).toMatchObject({
      overwriteImmutable: true,
      runValidators: true,
      strict: 'throw',
    });

    await expect(
      getConnectionSecret(ref, {
        clientId: CLIENT_A,
        provider: 'COOP',
        expectedVersion: 7,
      })
    ).resolves.toEqual(material);
  });

  test('does not write a record already encrypted with the current key', async () => {
    const ref = allocateCredentialsRef(CLIENT_A, 'COOP');
    await putConnectionSecret(ref, { password: 'current-key' }, {
      clientId: CLIENT_A,
      provider: 'COOP',
      credentialVersion: 1,
    });

    await expect(
      rewrapConnectionSecret(ref, {
        clientId: CLIENT_A,
        provider: 'COOP',
        expectedVersion: 1,
      })
    ).resolves.toEqual({ status: 'already_current' });

    expect(updateCredential).not.toHaveBeenCalled();
  });

  test('refuses rewrapping when the previous decryption key is unavailable', async () => {
    const ref = allocateCredentialsRef(CLIENT_A, 'COOP');
    await putConnectionSecret(ref, { password: 'old-key' }, {
      clientId: CLIENT_A,
      provider: 'COOP',
      credentialVersion: 2,
    });

    process.env.BANK_SECRETS_ENCRYPTION_KEY = '22'.repeat(32);
    delete process.env.BANK_SECRETS_ENCRYPTION_KEY_PREVIOUS;

    await expect(
      rewrapConnectionSecret(ref, {
        clientId: CLIENT_A,
        provider: 'COOP',
        expectedVersion: 2,
      })
    ).rejects.toThrow(/key.*not configured/i);

    expect(updateCredential).not.toHaveBeenCalled();
  });

  test('rejects a stale compare-and-swap without overwriting the stored envelope', async () => {
    const ref = allocateCredentialsRef(CLIENT_A, 'COOP');
    await putConnectionSecret(ref, { password: 'cas-test' }, {
      clientId: CLIENT_A,
      provider: 'COOP',
      credentialVersion: 2,
    });

    process.env.BANK_SECRETS_ENCRYPTION_KEY = '22'.repeat(32);
    process.env.BANK_SECRETS_ENCRYPTION_KEY_PREVIOUS = '11'.repeat(32);

    updateCredential.mockResolvedValueOnce({
      acknowledged: true,
      matchedCount: 0,
      modifiedCount: 0,
    });

    await expect(
      rewrapConnectionSecret(ref, {
        clientId: CLIENT_A,
        provider: 'COOP',
        expectedVersion: 2,
      })
    ).rejects.toThrow(/changed during key rotation/i);

    expect(records.get(ref).envelope.keyId).toBe(
      '02d449a31fbb267c'
    );
  });

  test('verifies a write whose acknowledgement was lost before returning success', async () => {
    const ref = allocateCredentialsRef(CLIENT_A, 'COOP');
    await putConnectionSecret(ref, { password: 'committed-before-timeout' }, {
      clientId: CLIENT_A,
      provider: 'COOP',
      credentialVersion: 4,
    });

    process.env.BANK_SECRETS_ENCRYPTION_KEY = '22'.repeat(32);
    process.env.BANK_SECRETS_ENCRYPTION_KEY_PREVIOUS = '11'.repeat(32);

    updateCredential.mockImplementationOnce(async (filter, update) => {
      const row = records.get(String(filter._id));
      if (!matchesFilter(row, filter)) {
        return { acknowledged: true, matchedCount: 0, modifiedCount: 0 };
      }

      records.set(String(filter._id), {
        ...structuredClone(row),
        envelope: structuredClone(update.$set.envelope),
      });

      throw new Error('simulated lost write acknowledgement');
    });

    await expect(
      rewrapConnectionSecret(ref, {
        clientId: CLIENT_A,
        provider: 'COOP',
        expectedVersion: 4,
      })
    ).resolves.toEqual({ status: 'rotated' });
  });

  test('does not claim success when an update acknowledgement is lost and the old envelope remains', async () => {
    const ref = allocateCredentialsRef(CLIENT_A, 'COOP');
    await putConnectionSecret(ref, { password: 'uncommitted-write' }, {
      clientId: CLIENT_A,
      provider: 'COOP',
      credentialVersion: 4,
    });

    process.env.BANK_SECRETS_ENCRYPTION_KEY = '22'.repeat(32);
    process.env.BANK_SECRETS_ENCRYPTION_KEY_PREVIOUS = '11'.repeat(32);

    updateCredential.mockRejectedValueOnce(
      new Error('simulated network failure before commit')
    );

    await expect(
      rewrapConnectionSecret(ref, {
        clientId: CLIENT_A,
        provider: 'COOP',
        expectedVersion: 4,
      })
    ).rejects.toThrow(/outcome is uncertain/i);

    expect(records.get(ref).envelope.keyId).toBe(
      '02d449a31fbb267c'
    );
  });

  test('fails read-back verification if the persisted envelope is corrupted', async () => {
    const ref = allocateCredentialsRef(CLIENT_A, 'COOP');
    await putConnectionSecret(ref, { password: 'read-back-test' }, {
      clientId: CLIENT_A,
      provider: 'COOP',
      credentialVersion: 5,
    });

    process.env.BANK_SECRETS_ENCRYPTION_KEY = '22'.repeat(32);
    process.env.BANK_SECRETS_ENCRYPTION_KEY_PREVIOUS = '11'.repeat(32);

    updateCredential.mockImplementationOnce(async (filter, update) => {
      const row = records.get(String(filter._id));
      const corrupted = structuredClone(update.$set.envelope);
      corrupted.authTag = '00'.repeat(16);
      records.set(String(filter._id), { ...row, envelope: corrupted });

      return { acknowledged: true, matchedCount: 1, modifiedCount: 1 };
    });

    await expect(
      rewrapConnectionSecret(ref, {
        clientId: CLIENT_A,
        provider: 'COOP',
        expectedVersion: 5,
      })
    ).rejects.toThrow(/integrity verification/i);
  });


});
