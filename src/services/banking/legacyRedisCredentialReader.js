import crypto from 'node:crypto';

const REDIS_KEY_PREFIX = 'tycoon:bank:secret:';
const ENVELOPE_FORMAT = 'tycoon-bank-secret';
const ENVELOPE_VERSION = 1;
const ENVELOPE_ALGORITHM = 'aes-256-gcm';
const AAD_PREFIX = `${ENVELOPE_FORMAT}:${ENVELOPE_VERSION}`;

export class LegacyCredentialReadError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'LegacyCredentialReadError';
    this.code = code;
  }
}

function fail(code, message) {
  throw new LegacyCredentialReadError(code, message);
}

function assertRef(value) {
  const ref = typeof value === 'string' ? value.trim() : '';

  if (!ref || ref.length > 512) {
    fail('LEGACY_CREDENTIAL_REF_INVALID', 'A valid credential reference is required');
  }

  return ref;
}

function assertVersion(value) {
  if (!Number.isSafeInteger(value) || value < 1) {
    fail(
      'LEGACY_CREDENTIAL_EXPECTED_VERSION_INVALID',
      'A valid expected credential version is required'
    );
  }

  return value;
}

function parseKey(name, raw) {
  if (typeof raw !== 'string' || !/^[0-9a-fA-F]{64}$/.test(raw)) {
    fail(
      'LEGACY_CREDENTIAL_KEY_CONFIGURATION_INVALID',
      `${name} must contain exactly 64 hexadecimal characters`
    );
  }

  const key = Buffer.from(raw, 'hex');
  const keyId = crypto.createHash('sha256')
    .update(key)
    .digest('hex')
    .slice(0, 16);

  return { key, keyId };
}

function makeKeyring(currentKeyHex, previousKeyHex) {
  const current = parseKey('legacy current key', currentKeyHex);
  const keysById = new Map([[current.keyId, current]]);

  if (previousKeyHex) {
    const previous = parseKey('legacy previous key', previousKeyHex);

    if (previous.keyId === current.keyId) {
      fail(
        'LEGACY_CREDENTIAL_KEY_CONFIGURATION_INVALID',
        'Legacy current and previous encryption keys must differ'
      );
    }

    keysById.set(previous.keyId, previous);
  }

  return keysById;
}

function parseEnvelope(raw) {
  let envelope;

  try {
    envelope = JSON.parse(raw);
  } catch {
    fail(
      'LEGACY_CREDENTIAL_ENVELOPE_INVALID',
      'Legacy Redis credential envelope is not valid JSON'
    );
  }

  if (
    !envelope ||
    typeof envelope !== 'object' ||
    Array.isArray(envelope) ||
    envelope.format !== ENVELOPE_FORMAT ||
    envelope.formatVersion !== ENVELOPE_VERSION ||
    envelope.algorithm !== ENVELOPE_ALGORITHM ||
    typeof envelope.keyId !== 'string' ||
    !/^[0-9a-f]{16}$/.test(envelope.keyId) ||
    typeof envelope.iv !== 'string' ||
    !/^[0-9a-f]{24}$/.test(envelope.iv) ||
    typeof envelope.tag !== 'string' ||
    !/^[0-9a-f]{32}$/.test(envelope.tag) ||
    typeof envelope.ciphertext !== 'string' ||
    !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)$/.test(
      envelope.ciphertext
    )
  ) {
    fail(
      'LEGACY_CREDENTIAL_ENVELOPE_INVALID',
      'Legacy Redis credential envelope is invalid or unsupported'
    );
  }

  const ciphertext = Buffer.from(envelope.ciphertext, 'base64');

  if (
    ciphertext.length === 0 ||
    ciphertext.toString('base64') !== envelope.ciphertext
  ) {
    fail(
      'LEGACY_CREDENTIAL_ENVELOPE_INVALID',
      'Legacy Redis credential ciphertext is malformed'
    );
  }

  return { envelope, ciphertext };
}

function decryptRecord(ref, envelope, ciphertext, keysById) {
  const selectedKey = keysById.get(envelope.keyId);

  if (!selectedKey) {
    fail(
      'LEGACY_CREDENTIAL_KEY_UNAVAILABLE',
      'Legacy credential requires an encryption key that is not configured'
    );
  }

  let record;

  try {
    const decipher = crypto.createDecipheriv(
      ENVELOPE_ALGORITHM,
      selectedKey.key,
      Buffer.from(envelope.iv, 'hex'),
      { authTagLength: 16 }
    );

    decipher.setAAD(
      Buffer.from(`${AAD_PREFIX}:${ref}`, 'utf8')
    );
    decipher.setAuthTag(Buffer.from(envelope.tag, 'hex'));

    const plaintext = Buffer.concat([
      decipher.update(ciphertext),
      decipher.final(),
    ]);

    record = JSON.parse(plaintext.toString('utf8'));
  } catch {
    fail(
      'LEGACY_CREDENTIAL_INTEGRITY_FAILED',
      'Legacy Redis credential failed authenticated decryption'
    );
  }

  if (
    !record ||
    typeof record !== 'object' ||
    Array.isArray(record) ||
    !record.material ||
    typeof record.material !== 'object' ||
    Array.isArray(record.material) ||
    typeof record.updatedAt !== 'string' ||
    !Number.isFinite(Date.parse(record.updatedAt))
  ) {
    fail(
      'LEGACY_CREDENTIAL_RECORD_INVALID',
      'Decrypted legacy credential record has an invalid structure'
    );
  }

  return {
    material: record.material,
    credentialVersion: record.credentialVersion,
    updatedAt: record.updatedAt,
    keyId: envelope.keyId,
  };
}

/**
 * Read exactly one legacy Redis credential by reference.
 *
 * This module deliberately exposes no Redis SET, DEL, SCAN or KEYS operation.
 * Legacy encryption keys are explicitly supplied and must remain separate
 * from the destination Mongo encryption key.
 */
export async function readLegacyRedisCredential({
  redis,
  credentialsRef,
  expectedVersion,
  currentKeyHex,
  previousKeyHex = '',
} = {}) {
  const ref = assertRef(credentialsRef);
  const version = assertVersion(expectedVersion);

  if (!redis || typeof redis.get !== 'function') {
    fail(
      'LEGACY_REDIS_CLIENT_INVALID',
      'A Redis client with a GET operation is required'
    );
  }

  const keysById = makeKeyring(currentKeyHex, previousKeyHex);

  let raw;

  try {
    raw = await redis.get(`${REDIS_KEY_PREFIX}${ref}`);
  } catch {
    fail(
      'LEGACY_REDIS_UNAVAILABLE',
      'Legacy Redis credential lookup failed'
    );
  }

  if (raw === null || raw === undefined) {
    fail(
      'LEGACY_CREDENTIAL_MISSING',
      'Legacy Redis credential was not found'
    );
  }

  if (typeof raw !== 'string') {
    fail(
      'LEGACY_CREDENTIAL_ENVELOPE_INVALID',
      'Legacy Redis credential must be a serialized envelope'
    );
  }

  const { envelope, ciphertext } = parseEnvelope(raw);
  const record = decryptRecord(ref, envelope, ciphertext, keysById);

  if (
    !Number.isSafeInteger(record.credentialVersion) ||
    record.credentialVersion < 1
  ) {
    fail(
      'LEGACY_CREDENTIAL_VERSION_MISSING',
      'Legacy credential has no valid stored credential version'
    );
  }

  if (record.credentialVersion !== version) {
    fail(
      'LEGACY_CREDENTIAL_VERSION_MISMATCH',
      'Legacy credential version does not match the persisted connection'
    );
  }

  return {
    material: record.material,
    credentialVersion: record.credentialVersion,
    updatedAt: record.updatedAt,
    encryptionKeyId: record.keyId,
  };
}
