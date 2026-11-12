import crypto from 'node:crypto';
import { jest } from '@jest/globals';
import '../setup.js';

import {
  readLegacyRedisCredential,
} from '../../src/services/banking/legacyRedisCredentialReader.js';

const CURRENT_KEY = '11'.repeat(32);
const PREVIOUS_KEY = '22'.repeat(32);

const REF = 'secrets://bank/connections/coop/client-1/legacy-test';
const UPDATED_AT = '2026-11-11T12:00:00.000Z';

function keyId(raw) {
  return crypto.createHash('sha256')
    .update(Buffer.from(raw, 'hex'))
    .digest('hex')
    .slice(0, 16);
}

function encryptLegacyRecord(
  ref,
  record,
  keyHex = CURRENT_KEY,
  iv = Buffer.alloc(12, 7)
) {
  const key = Buffer.from(keyHex, 'hex');
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);

  cipher.setAAD(
    Buffer.from('tycoon-bank-secret:1:' + ref, 'utf8')
  );

  const ciphertext = Buffer.concat([
    cipher.update(Buffer.from(JSON.stringify(record), 'utf8')),
    cipher.final(),
  ]);

  return JSON.stringify({
    format: 'tycoon-bank-secret',
    formatVersion: 1,
    algorithm: 'aes-256-gcm',
    keyId: keyId(keyHex),
    iv: iv.toString('hex'),
    tag: cipher.getAuthTag().toString('hex'),
    ciphertext: ciphertext.toString('base64'),
  });
}

function makeRedis(raw) {
  return {
    get: jest.fn().mockResolvedValue(raw),
  };
}

function makeRecord(overrides = {}) {
  return {
    material: {
      clientId: 'coop-provider-client',
      clientSecret: 'provider-secret-fixture',
      username: 'bank-user',
      password: 'bank-password-fixture',
    },
    credentialVersion: 3,
    updatedAt: UPDATED_AT,
    ...overrides,
  };
}

function read(redis, overrides = {}) {
  return readLegacyRedisCredential({
    redis,
    credentialsRef: REF,
    expectedVersion: 3,
    currentKeyHex: CURRENT_KEY,
    ...overrides,
  });
}

describe('legacy Redis credential migration reader', () => {
  test('decrypts one exact reference and returns its versioned material', async () => {
    const record = makeRecord();
    const redis = makeRedis(encryptLegacyRecord(REF, record));

    await expect(read(redis)).resolves.toEqual({
      material: record.material,
      credentialVersion: 3,
      updatedAt: UPDATED_AT,
      encryptionKeyId: keyId(CURRENT_KEY),
    });

    expect(redis.get).toHaveBeenCalledTimes(1);
    expect(redis.get).toHaveBeenCalledWith(
      'tycoon:bank:secret:' + REF
    );

    // This reader is provided only GET, so writes and deletion are impossible
    // through its public dependency.
  });

  test('decrypts records using the separately supplied previous legacy key', async () => {
    const redis = makeRedis(
      encryptLegacyRecord(REF, makeRecord(), PREVIOUS_KEY)
    );

    await expect(
      read(redis, { previousKeyHex: PREVIOUS_KEY })
    ).resolves.toMatchObject({
      credentialVersion: 3,
      encryptionKeyId: keyId(PREVIOUS_KEY),
    });
  });

  test('rejects a missing Redis credential', async () => {
    const redis = makeRedis(null);

    await expect(read(redis)).rejects.toMatchObject({
      code: 'LEGACY_CREDENTIAL_MISSING',
    });
  });

  test('rejects malformed JSON', async () => {
    const redis = makeRedis('{not-json');

    await expect(read(redis)).rejects.toMatchObject({
      code: 'LEGACY_CREDENTIAL_ENVELOPE_INVALID',
    });
  });

  test('rejects plaintext legacy records without a fallback', async () => {
    const redis = makeRedis(JSON.stringify(makeRecord()));

    await expect(read(redis)).rejects.toMatchObject({
      code: 'LEGACY_CREDENTIAL_ENVELOPE_INVALID',
    });
  });

  test('rejects an unknown encryption key ID', async () => {
    const envelope = JSON.parse(
      encryptLegacyRecord(REF, makeRecord())
    );
    envelope.keyId = 'abcdef0123456789';

    const redis = makeRedis(JSON.stringify(envelope));

    await expect(read(redis)).rejects.toMatchObject({
      code: 'LEGACY_CREDENTIAL_KEY_UNAVAILABLE',
    });
  });

  test('rejects ciphertext modified after encryption', async () => {
    const envelope = JSON.parse(
      encryptLegacyRecord(REF, makeRecord())
    );
    envelope.tag = '00'.repeat(16);

    const redis = makeRedis(JSON.stringify(envelope));

    await expect(read(redis)).rejects.toMatchObject({
      code: 'LEGACY_CREDENTIAL_INTEGRITY_FAILED',
    });
  });

  test('rejects an envelope copied to a different credential reference', async () => {
    const otherRef = REF + '-other';
    const redis = makeRedis(
      encryptLegacyRecord(REF, makeRecord())
    );

    await expect(
      readLegacyRedisCredential({
        redis,
        credentialsRef: otherRef,
        expectedVersion: 3,
        currentKeyHex: CURRENT_KEY,
      })
    ).rejects.toMatchObject({
      code: 'LEGACY_CREDENTIAL_INTEGRITY_FAILED',
    });
  });

  test('rejects a version mismatch', async () => {
    const redis = makeRedis(
      encryptLegacyRecord(
        REF,
        makeRecord({ credentialVersion: 2 })
      )
    );

    await expect(read(redis)).rejects.toMatchObject({
      code: 'LEGACY_CREDENTIAL_VERSION_MISMATCH',
    });
  });

  test('rejects a missing credential version', async () => {
    const redis = makeRedis(
      encryptLegacyRecord(
        REF,
        makeRecord({ credentialVersion: null })
      )
    );

    await expect(read(redis)).rejects.toMatchObject({
      code: 'LEGACY_CREDENTIAL_VERSION_MISSING',
    });
  });

  test('rejects an invalid expected version before Redis access', async () => {
    const redis = makeRedis(null);

    await expect(
      read(redis, { expectedVersion: null })
    ).rejects.toMatchObject({
      code: 'LEGACY_CREDENTIAL_EXPECTED_VERSION_INVALID',
    });

    expect(redis.get).not.toHaveBeenCalled();
  });

  test('rejects invalid legacy encryption keys before Redis access', async () => {
    const redis = makeRedis(null);

    await expect(
      read(redis, { currentKeyHex: 'invalid' })
    ).rejects.toMatchObject({
      code: 'LEGACY_CREDENTIAL_KEY_CONFIGURATION_INVALID',
    });

    expect(redis.get).not.toHaveBeenCalled();
  });

  test('rejects identical current and previous legacy keys', async () => {
    const redis = makeRedis(null);

    await expect(
      read(redis, { previousKeyHex: CURRENT_KEY })
    ).rejects.toMatchObject({
      code: 'LEGACY_CREDENTIAL_KEY_CONFIGURATION_INVALID',
    });

    expect(redis.get).not.toHaveBeenCalled();
  });

  test('classifies a Redis lookup failure without exposing connection details', async () => {
    const redis = {
      get: jest.fn().mockRejectedValue(
        new Error('redis://user:secret@host:6379 unavailable')
      ),
    };

    await expect(read(redis)).rejects.toMatchObject({
      code: 'LEGACY_REDIS_UNAVAILABLE',
      message: 'Legacy Redis credential lookup failed',
    });
  });

  test('rejects an invalid decrypted record structure', async () => {
    const redis = makeRedis(
      encryptLegacyRecord(REF, {
        material: [],
        credentialVersion: 3,
        updatedAt: UPDATED_AT,
      })
    );

    await expect(read(redis)).rejects.toMatchObject({
      code: 'LEGACY_CREDENTIAL_RECORD_INVALID',
    });
  });
});
