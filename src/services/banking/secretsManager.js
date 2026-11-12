import crypto from 'crypto';
import { isDeepStrictEqual } from 'node:util';
import { BankCredential } from '../../models/BankCredential.js';
import { BANK_CONNECTION_PROVIDERS } from '../../models/BankConnection.js';
import { Errors } from '../../utils/errors.js';
import { env } from '../../config/environment.js';

const ENVELOPE_FORMAT = 'tycoon-bank-credential';
const ENVELOPE_VERSION = 1;
const ENVELOPE_ALGORITHM = 'aes-256-gcm';

function assertRef(ref) {
  const value = typeof ref === 'string' ? ref.trim() : '';
  if (!value || value.length > 512) {
    throw Errors.InvalidRequest('A valid credentialsRef is required');
  }
  return value;
}

function assertOwner(clientId, provider) {
  // ObjectId hex strings are case-insensitive. Canonicalize before using
  // the owner in Mongo queries and AES-GCM associated data.
  const ownerId = clientId == null
    ? ''
    : String(clientId).trim().toLowerCase();
  const providerCode = typeof provider === 'string'
    ? provider.trim().toUpperCase()
    : '';

  // BankConnection.clientId is an ObjectId. Reject malformed ownership
  // context before it reaches a database query.
  if (!/^[0-9a-f]{24}$/i.test(ownerId)) {
    throw Errors.InvalidRequest('A valid clientId is required for bank credentials');
  }
  if (!BANK_CONNECTION_PROVIDERS.includes(providerCode)) {
    throw Errors.InvalidRequest('A supported bank provider is required for bank credentials');
  }

  return { clientId: ownerId, provider: providerCode };
}

function assertVersion(value, label = 'credentialVersion') {
  const version = Number(value);
  if (!Number.isSafeInteger(version) || version < 1) {
    throw Errors.InvalidRequest(`${label} must be a safe integer >= 1`);
  }
  return version;
}

/**
 * Resolve keys dynamically so controlled key-rotation tests and processes
 * can change environment values without reusing a stale module-level key.
 */
function configuredValue(name) {
  if (Object.prototype.hasOwnProperty.call(process.env, name)) {
    return process.env[name] || '';
  }
  return env[name] || '';
}

function parseEncryptionKey(name, raw) {
  if (!/^[0-9a-fA-F]{64}$/.test(raw)) {
    throw new Error(
      `[config] ${name} must be exactly 64 hexadecimal characters (32 bytes). ` +
      'Generate with: node -e "console.log(require(\'crypto\').randomBytes(32).toString(\'hex\'))"'
    );
  }

  const key = Buffer.from(raw, 'hex');
  const keyId = crypto.createHash('sha256').update(key).digest('hex').slice(0, 16);
  return { key, keyId };
}

/**
 * The current key encrypts new credential records. The optional previous key
 * is read-only and remains configured until all records using it are rotated.
 */
function bankCredentialKeyring() {
  const currentRaw = configuredValue('BANK_SECRETS_ENCRYPTION_KEY');
  const previousRaw = configuredValue('BANK_SECRETS_ENCRYPTION_KEY_PREVIOUS');

  if (!currentRaw) {
    throw new Error('[config] BANK_SECRETS_ENCRYPTION_KEY is required');
  }

  const current = parseEncryptionKey('BANK_SECRETS_ENCRYPTION_KEY', currentRaw);
  const keysById = new Map([[current.keyId, current]]);

  if (previousRaw) {
    const previous = parseEncryptionKey(
      'BANK_SECRETS_ENCRYPTION_KEY_PREVIOUS',
      previousRaw
    );

    if (previous.keyId === current.keyId) {
      throw new Error(
        '[config] BANK_SECRETS_ENCRYPTION_KEY_PREVIOUS must differ from the current key'
      );
    }

    keysById.set(previous.keyId, previous);
  }

  return { current, keysById };
}

function assertCredentialMaterial(material) {
  if (!material || typeof material !== 'object' || Array.isArray(material)) {
    throw Errors.InvalidRequest('credential material must be a non-null object');
  }
}

function associatedData(ref, owner, version) {
  // Bind the ciphertext to the credential reference, owner, provider and
  // version. Copying a document across any of these identities breaks GCM.
  return Buffer.from(JSON.stringify([
    ENVELOPE_FORMAT,
    ENVELOPE_VERSION,
    ref,
    owner.clientId,
    owner.provider,
    version,
  ]), 'utf8');
}

function encryptCredential(ref, owner, version, material) {
  const { current } = bankCredentialKeyring();
  const iv = crypto.randomBytes(12);

  let plaintext;
  try {
    plaintext = Buffer.from(JSON.stringify(material), 'utf8');
  } catch {
    throw Errors.InvalidRequest('credential material must be JSON-serializable');
  }

  const cipher = crypto.createCipheriv(
    ENVELOPE_ALGORITHM,
    current.key,
    iv,
    { authTagLength: 16 }
  );

  cipher.setAAD(associatedData(ref, owner, version));

  const ciphertext = Buffer.concat([
    cipher.update(plaintext),
    cipher.final(),
  ]);

  return {
    format: ENVELOPE_FORMAT,
    formatVersion: ENVELOPE_VERSION,
    algorithm: ENVELOPE_ALGORITHM,
    keyId: current.keyId,
    iv: iv.toString('hex'),
    authTag: cipher.getAuthTag().toString('hex'),
    ciphertext: ciphertext.toString('base64'),
  };
}

function decryptCredential(ref, owner, version, envelope) {
  if (
    !envelope ||
    typeof envelope !== 'object' ||
    envelope.format !== ENVELOPE_FORMAT ||
    envelope.formatVersion !== ENVELOPE_VERSION ||
    envelope.algorithm !== ENVELOPE_ALGORITHM ||
    typeof envelope.keyId !== 'string' ||
    !/^[0-9a-f]{16}$/.test(envelope.keyId) ||
    typeof envelope.iv !== 'string' ||
    !/^[0-9a-f]{24}$/.test(envelope.iv) ||
    typeof envelope.authTag !== 'string' ||
    !/^[0-9a-f]{32}$/.test(envelope.authTag) ||
    typeof envelope.ciphertext !== 'string' ||
    !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(
      envelope.ciphertext
    )
  ) {
    throw Errors.BankAuthFailed('Stored bank credential record is invalid or unsupported');
  }

  const { keysById } = bankCredentialKeyring();
  const selectedKey = keysById.get(envelope.keyId);

  if (!selectedKey) {
    throw Errors.BankAuthFailed(
      'Stored bank credential record uses an encryption key that is not configured'
    );
  }

  const ciphertext = Buffer.from(envelope.ciphertext, 'base64');
  if (
    ciphertext.length === 0 ||
    ciphertext.toString('base64') !== envelope.ciphertext
  ) {
    throw Errors.BankAuthFailed('Stored bank credential ciphertext is malformed');
  }

  try {
    const decipher = crypto.createDecipheriv(
      ENVELOPE_ALGORITHM,
      selectedKey.key,
      Buffer.from(envelope.iv, 'hex'),
      { authTagLength: 16 }
    );

    decipher.setAAD(associatedData(ref, owner, version));
    decipher.setAuthTag(Buffer.from(envelope.authTag, 'hex'));

    const plaintext = Buffer.concat([
      decipher.update(ciphertext),
      decipher.final(),
    ]);

    const material = JSON.parse(plaintext.toString('utf8'));
    assertCredentialMaterial(material);
    return material;
  } catch {
    throw Errors.BankAuthFailed(
      'Stored bank credential record failed integrity verification'
    );
  }
}

/**
 * Startup validation. MongoDB is the only credential store; Redis is not
 * consulted by this module.
 */
export function assertBankCredentialEncryptionConfigured() {
  bankCredentialKeyring();
  return true;
}

/**
 * Persist one immutable encrypted credential version in MongoDB.
 * A new reference is allocated for each staged rotation.
 */
export async function putConnectionSecret(
  credentialsRef,
  material,
  { clientId, provider, credentialVersion } = {}
) {
  const ref = assertRef(credentialsRef);
  const owner = assertOwner(clientId, provider);
  const version = assertVersion(credentialVersion);

  assertCredentialMaterial(material);
  const envelope = encryptCredential(ref, owner, version, material);

  try {
    await BankCredential.create({
      _id: ref,
      clientId: owner.clientId,
      provider: owner.provider,
      credentialVersion: version,
      envelope,
    });
  } catch (error) {
    if (error?.code === 11000) {
      throw Errors.Conflict('Credential reference already exists');
    }
    throw error;
  }

  return ref;
}

/**
 * Import one legacy credential reference into MongoDB.
 *
 * This operation is create-only. It never replaces an existing document.
 * Repeated imports are safe only when the existing document has the exact
 * owner, provider, version and decrypted material.
 */
export async function importConnectionSecret(
  credentialsRef,
  material,
  { clientId, provider, credentialVersion } = {}
) {
  const ref = assertRef(credentialsRef);
  const owner = assertOwner(clientId, provider);
  const version = assertVersion(credentialVersion);

  assertCredentialMaterial(material);

  // Stage the destination envelope before attempting the persistent write.
  const envelope = encryptCredential(ref, owner, version, material);

  const readImportRecord = async () => {
    try {
      return await BankCredential.findOne({ _id: ref }).lean();
    } catch {
      throw Errors.Conflict(
        'Credential import outcome is uncertain; unable to verify persisted state'
      );
    }
  };

  const verifyExistingRecord = (row) => {
    const identityMatches = Boolean(row) &&
      String(row._id) === ref &&
      String(row.clientId) === owner.clientId &&
      String(row.provider).toUpperCase() === owner.provider &&
      Number.isSafeInteger(Number(row.credentialVersion)) &&
      Number(row.credentialVersion) === version;

    if (!identityMatches) {
      throw Errors.Conflict(
        'Credential reference is already bound to a different credential record'
      );
    }

    const existingMaterial = decryptCredential(
      ref,
      owner,
      version,
      row.envelope
    );

    if (!isDeepStrictEqual(existingMaterial, material)) {
      throw Errors.Conflict(
        'Credential reference already contains different credential material'
      );
    }
  };

  const reconcileFailedWrite = async (writeError) => {
    const existing = await readImportRecord();

    if (!existing) {
      if (writeError?.code === 11000) {
        throw Errors.Conflict(
          'Credential reference already exists but could not be verified'
        );
      }

      throw Errors.Conflict(
        'Credential import outcome is uncertain; no committed record is visible'
      );
    }

    verifyExistingRecord(existing);
    return { status: 'already_present' };
  };

  try {
    await BankCredential.create({
      _id: ref,
      clientId: owner.clientId,
      provider: owner.provider,
      credentialVersion: version,
      envelope,
    });
  } catch (error) {
    // Includes duplicate-key errors and writes whose acknowledgement may
    // have been lost. Reconcile by reading; never overwrite or delete.
    return reconcileFailedWrite(error);
  }

  // Acknowledgement is not sufficient. Verify the exact persisted record.
  const persisted = await readImportRecord();

  if (!persisted) {
    throw Errors.Conflict(
      'Credential import was acknowledged but the persisted record is not visible'
    );
  }

  verifyExistingRecord(persisted);
  return { status: 'imported' };
}

/**
 * Retrieve only when the caller supplies the expected owner, provider and
 * exact credential version from the persisted BankConnection.
 */
export async function getConnectionSecret(
  credentialsRef,
  { clientId, provider, expectedVersion } = {}
) {
  const ref = assertRef(credentialsRef);
  const owner = assertOwner(clientId, provider);
  const version = assertVersion(expectedVersion, 'expectedVersion');

  const row = await BankCredential.findOne({
    _id: ref,
    clientId: owner.clientId,
    provider: owner.provider,
  }).lean();

  if (!row) {
    throw Errors.BankAuthFailed('Connection credential material not found');
  }

  const storedVersion = Number(row.credentialVersion);
  if (
    !Number.isSafeInteger(storedVersion) ||
    storedVersion < 1 ||
    storedVersion !== version
  ) {
    throw Errors.BankAuthFailed('Connection credential version mismatch');
  }

  // Verify the returned document still matches the requested ownership
  // context before attempting authenticated decryption.
  if (
    String(row.clientId) !== owner.clientId ||
    String(row.provider).toUpperCase() !== owner.provider
  ) {
    throw Errors.BankAuthFailed('Connection credential ownership mismatch');
  }

  return decryptCredential(ref, owner, version, row.envelope);
}


/**
 * Re-encrypt one stored credential under the current application key.
 *
 * This is a maintenance-only exception to the immutable envelope schema.
 * Ownership, provider, reference and credential version remain unchanged.
 * The old envelope is part of the update filter, making replacement CAS-safe.
 */
export async function rewrapConnectionSecret(
  credentialsRef,
  { clientId, provider, expectedVersion } = {}
) {
  const ref = assertRef(credentialsRef);
  const owner = assertOwner(clientId, provider);
  const version = assertVersion(expectedVersion, 'expectedVersion');
  const identityFilter = {
    _id: ref,
    clientId: owner.clientId,
    provider: owner.provider,
    credentialVersion: version,
  };

  const readRow = async () => BankCredential.findOne(identityFilter).lean();

  const assertRowIdentity = (row) => {
    if (!row) {
      throw Errors.BankAuthFailed('Connection credential material not found');
    }

    if (
      String(row.clientId) !== owner.clientId ||
      String(row.provider).toUpperCase() !== owner.provider
    ) {
      throw Errors.BankAuthFailed('Connection credential ownership mismatch');
    }

    if (
      !Number.isSafeInteger(Number(row.credentialVersion)) ||
      Number(row.credentialVersion) !== version
    ) {
      throw Errors.BankAuthFailed('Connection credential version mismatch');
    }
  };

  const originalRow = await readRow();
  assertRowIdentity(originalRow);

  const { current } = bankCredentialKeyring();
  const originalMaterial = decryptCredential(
    ref,
    owner,
    version,
    originalRow.envelope
  );

  if (originalRow.envelope.keyId === current.keyId) {
    return { status: 'already_current' };
  }

  const nextEnvelope = encryptCredential(
    ref,
    owner,
    version,
    originalMaterial
  );

  // Verify the new envelope before allowing it near persistent storage.
  const stagedMaterial = decryptCredential(
    ref,
    owner,
    version,
    nextEnvelope
  );

  if (!isDeepStrictEqual(stagedMaterial, originalMaterial)) {
    throw Errors.BankAuthFailed(
      'Credential encryption-key rotation failed pre-write verification'
    );
  }

  const oldEnvelope = originalRow.envelope;
  const compareAndSwapFilter = {
    ...identityFilter,
    'envelope.format': oldEnvelope.format,
    'envelope.formatVersion': oldEnvelope.formatVersion,
    'envelope.algorithm': oldEnvelope.algorithm,
    'envelope.keyId': oldEnvelope.keyId,
    'envelope.iv': oldEnvelope.iv,
    'envelope.authTag': oldEnvelope.authTag,
    'envelope.ciphertext': oldEnvelope.ciphertext,
  };

  let updateResult;

  try {
    updateResult = await BankCredential.updateOne(
      compareAndSwapFilter,
      { $set: { envelope: nextEnvelope } },
      {
        // The schema intentionally makes the envelope immutable for normal
        // application writes. Only this maintenance operation overrides it.
        overwriteImmutable: true,
        runValidators: true,
        strict: 'throw',
      }
    );
  } catch {
    // The database may have committed before its acknowledgement was lost.
    // Verify persisted state before deciding whether the rotation succeeded.
    let latest;
    try {
      latest = await readRow();
      assertRowIdentity(latest);

      const verified = decryptCredential(
        ref,
        owner,
        version,
        latest.envelope
      );

      if (
        latest.envelope.keyId === current.keyId &&
        isDeepStrictEqual(verified, originalMaterial)
      ) {
        return { status: 'rotated' };
      }
    } catch {
      // Keep the outcome classified as uncertain. Never retry blindly or
      // retire the previous key based on an unverified write.
    }

    throw Errors.Conflict(
      'Credential key rotation outcome is uncertain; verify the stored envelope before retrying'
    );
  }

  if (updateResult?.matchedCount !== 1) {
    // A concurrent rotation may already have won the compare-and-swap.
    const latest = await readRow();
    assertRowIdentity(latest);

    const latestMaterial = decryptCredential(
      ref,
      owner,
      version,
      latest.envelope
    );

    if (
      latest.envelope.keyId === current.keyId &&
      isDeepStrictEqual(latestMaterial, originalMaterial)
    ) {
      return { status: 'already_current' };
    }

    throw Errors.Conflict(
      'Credential changed during key rotation; reload and retry'
    );
  }

  // Read-back verification is mandatory. A successful update acknowledgement
  // alone is not proof that the new envelope is usable.
  const persisted = await readRow();
  assertRowIdentity(persisted);

  const verifiedMaterial = decryptCredential(
    ref,
    owner,
    version,
    persisted.envelope
  );

  if (
    persisted.envelope.keyId !== current.keyId ||
    !isDeepStrictEqual(verifiedMaterial, originalMaterial)
  ) {
    throw Errors.BankAuthFailed(
      'Credential key rotation failed read-back verification'
    );
  }

  return { status: 'rotated' };
}

/**
 * Delete is deliberately ownership- and version-scoped. A stale cleanup
 * operation cannot delete a different client's or newer credential record.
 */
export async function deleteConnectionSecret(
  credentialsRef,
  { clientId, provider, expectedVersion } = {}
) {
  const ref = assertRef(credentialsRef);
  const owner = assertOwner(clientId, provider);
  const version = assertVersion(expectedVersion, 'expectedVersion');

  return BankCredential.deleteOne({
    _id: ref,
    clientId: owner.clientId,
    provider: owner.provider,
    credentialVersion: version,
  });
}

export function allocateCredentialsRef(clientId, provider) {
  const owner = assertOwner(clientId, provider);
  const id = crypto.randomBytes(16).toString('hex');

  return (
    `secrets://bank/connections/${owner.provider.toLowerCase()}/` +
    `${owner.clientId}/${id}`
  );
}

export const secretsManager = {
  putConnectionSecret,
  importConnectionSecret,
  getConnectionSecret,
  rewrapConnectionSecret,
  deleteConnectionSecret,
  allocateCredentialsRef,
  assertBankCredentialEncryptionConfigured,
};
