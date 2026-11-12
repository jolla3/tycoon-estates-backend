// src/services/connection.service.js
//
// G4 Batch 02: BankConnection lifecycle — create, reauthorize, disconnect.
// Connection authentication is separate from account validation/entitlements.

import { BankConnection } from '../models/BankConnection.js';
import {
  assertProviderOperational,
  createBankProviderForConnection,
} from './banking/bank.factory.js';
import {
  allocateCredentialsRef,
  putConnectionSecret,
  getConnectionSecret,
  deleteConnectionSecret,
} from './banking/secretsManager.js';
import { Errors } from '../utils/errors.js';
import { logger } from '../config/logger.js';
import { audit } from './audit.service.js';
import { sanitizeBankConnection } from '../models/BankConnection.js';

function sanitizeAuthError(err) {
  const msg = err?.message ? String(err.message).slice(0, 200) : 'authentication_failed';
  // Never persist stack traces, tokens, or raw provider payloads.
  return msg.replace(/Bearer\s+\S+/gi, 'Bearer [redacted]');
}

function toPublic(connection) {
  if (!connection) return null;
  const c = typeof connection.toObject === 'function' ? connection.toObject() : { ...connection };
  return {
    id: c._id,
    clientId: c.clientId,
    provider: c.provider,
    displayName: c.displayName || null,
    status: c.status,
    credentialVersion: c.credentialVersion,
    authMeta: {
      tokenExpiresAt: c.authMeta?.tokenExpiresAt || null,
      lastAuthAt: c.authMeta?.lastAuthAt || null,
      lastAuthError: c.authMeta?.lastAuthError || null,
      externalClientId: c.authMeta?.externalClientId || null,
    },
    createdAt: c.createdAt,
    updatedAt: c.updatedAt,
  };
}

export const connectionService = {
  /**
   * Create a connection and store credential material in the secrets manager.
   * credentialMaterial is provider-specific and never written to Mongo.
   */
  async create(clientId, { provider, displayName, credentialMaterial }, userId = null) {
    const normalizedProvider = String(provider).toUpperCase();
    assertProviderOperational(normalizedProvider, { allowLab: true });
    if (!credentialMaterial || typeof credentialMaterial !== 'object' || Array.isArray(credentialMaterial)) {
      throw Errors.InvalidRequest('credentialMaterial is required');
    }

    const credentialsRef = allocateCredentialsRef(clientId, normalizedProvider);
    await putConnectionSecret(credentialsRef, credentialMaterial, {
      clientId,
      provider: normalizedProvider,
      credentialVersion: 1,
    });

    let connection;
    try {
      connection = await BankConnection.create({
        clientId,
        provider: normalizedProvider,
        displayName: displayName || null,
        status: 'pending',
        credentialsRef,
        credentialVersion: 1,
        createdByUserId: userId,
        updatedByUserId: userId,
        authMeta: {},
      });
    } catch (createError) {
      // An insert can commit even when its acknowledgement is lost.
      // Check the primary before deciding whether the staged secret is orphaned.
      try {
        const lookup = BankConnection.findOne({
          clientId,
          credentialsRef,
          credentialVersion: 1,
        });

        const primaryLookup = typeof lookup?.read === 'function'
          ? lookup.read('primary')
          : lookup;

        const persisted = await primaryLookup;

        if (persisted) {
          logger.warn({
            clientId: String(clientId),
            provider: normalizedProvider,
          }, 'BankConnection create acknowledgement failed but its reference exists; credentials retained');
        } else {
          // Absence immediately after an ambiguous write is not proof that
          // the write cannot still commit. Retain the credential for delayed
          // orphan reconciliation instead of risking a dangling connection.
          logger.warn({
            clientId: String(clientId),
            provider: normalizedProvider,
          }, 'BankConnection create failed and no reference is currently visible; credentials retained for orphan reconciliation');
        }
      } catch {
        // Never delete credentials when the reference check or cleanup is uncertain.
        logger.error({
          clientId: String(clientId),
          provider: normalizedProvider,
        }, 'BankConnection creation outcome is uncertain; staged credentials retained');
      }

      throw createError;
    }

    try {
      const material = await getConnectionSecret(credentialsRef, {
        clientId: connection.clientId,
        provider: connection.provider,
        expectedVersion: 1,
      });
      const adapter = createBankProviderForConnection(connection.provider, material, {
        connectionId: String(connection._id),
        credentialVersion: connection.credentialVersion,
      });
      await adapter.authenticate();
      connection.status = 'active';
      connection.authMeta = {
        ...(connection.authMeta?.toObject?.() || connection.authMeta || {}),
        lastAuthAt: new Date(),
        lastAuthError: null,
        tokenExpiresAt: null,
      };
      await connection.save();
    } catch (err) {
      connection.status = 'failed';
      connection.authMeta = {
        lastAuthAt: new Date(),
        lastAuthError: sanitizeAuthError(err),
        tokenExpiresAt: null,
      };
      await connection.save();
      logger.warn({
        clientId: String(clientId),
        connectionId: String(connection._id),
        provider: connection.provider,
        error: sanitizeAuthError(err),
      }, 'BankConnection authentication failed at create');
    }

    await audit({
      clientId,
      userId,
      action: 'BANK_CONNECTION_CREATED',
      resource: 'BankConnection',
      resourceId: connection._id,
      metadata: { provider: connection.provider, status: connection.status },
    });

    return toPublic(connection);
  },

  async list(clientId) {
    const rows = await BankConnection.find({ clientId }).sort({ createdAt: -1 });
    return rows.map(toPublic);
  },

  async get(clientId, connectionId) {
    const connection = await BankConnection.findOne({ _id: connectionId, clientId });
    if (!connection) throw Errors.NotFound('Bank connection not found');
    return connection;
  },

  async getPublic(clientId, connectionId) {
    return toPublic(await this.get(clientId, connectionId));
  },

  /**
   * Rotate credential material and bump credentialVersion (invalidates prior token caches).
   */
  async reauthorize(clientId, connectionId, credentialMaterial, userId = null) {
    const connection = await this.get(clientId, connectionId);

    if (connection.status === 'disconnected') {
      throw Errors.Conflict('Disconnected connections cannot be reauthorized; create a new connection');
    }
    if (!credentialMaterial || typeof credentialMaterial !== 'object' || Array.isArray(credentialMaterial)) {
      throw Errors.InvalidRequest('credentialMaterial is required');
    }

    const oldCredentialsRef = connection.credentialsRef;
    const oldCredentialVersion = Number(connection.credentialVersion);

    if (
      !oldCredentialsRef
      || !Number.isSafeInteger(oldCredentialVersion)
      || oldCredentialVersion < 1
      || !connection.updatedAt
    ) {
      throw Errors.BankAuthFailed('Connection credential state is incomplete; refusing reauthorization');
    }

    const nextCredentialVersion = oldCredentialVersion + 1;
    const credentialOwner = {
      clientId: connection.clientId,
      provider: connection.provider,
    };
    const stagedCredentialsRef = allocateCredentialsRef(
      credentialOwner.clientId,
      credentialOwner.provider
    );

    const discardStagedSecret = async () => {
      try {
        await deleteConnectionSecret(stagedCredentialsRef, {
          ...credentialOwner,
          expectedVersion: nextCredentialVersion,
        });
      } catch {
        logger.error({
          clientId: String(clientId),
          connectionId: String(connection._id),
        }, 'Failed to remove staged bank credentials');
      }
    };

    try {
      await putConnectionSecret(stagedCredentialsRef, credentialMaterial, {
        ...credentialOwner,
        credentialVersion: nextCredentialVersion,
      });
    } catch (err) {
      await discardStagedSecret();
      throw err;
    }

    // Authenticate the staged credentials without changing the live connection.
    try {
      const material = await getConnectionSecret(stagedCredentialsRef, {
        ...credentialOwner,
        expectedVersion: nextCredentialVersion,
      });
      const adapter = createBankProviderForConnection(connection.provider, material, {
        connectionId: String(connection._id),
        credentialVersion: nextCredentialVersion,
      });
      await adapter.authenticate();
    } catch {
      await discardStagedSecret();
      logger.warn({
        clientId: String(clientId),
        connectionId: String(connection._id),
        attemptedCredentialVersion: nextCredentialVersion,
      }, 'BankConnection reauthorization failed; existing credentials were retained');
      throw Errors.BankAuthFailed('Bank connection reauthorization failed; existing credentials were retained');
    }

    // Promote only if the connection is still exactly the version/state we authenticated against.
    let updated;
    try {
      updated = await BankConnection.findOneAndUpdate(
        {
          _id: connection._id,
          clientId,
          credentialsRef: oldCredentialsRef,
          credentialVersion: oldCredentialVersion,
          status: connection.status,
          updatedAt: connection.updatedAt,
        },
        {
          $set: {
            credentialsRef: stagedCredentialsRef,
            credentialVersion: nextCredentialVersion,
            updatedByUserId: userId,
            status: 'active',
            authMeta: {
              lastAuthAt: new Date(),
              lastAuthError: null,
              tokenExpiresAt: null,
            },
          },
        },
        { new: true, runValidators: true }
      );
    } catch (err) {
      // A network/driver error can occur after MongoDB commits the update.
      // Retaining the staged secret is safer than deleting credentials that
      // may already be referenced by the live BankConnection.
      logger.error({
        clientId: String(clientId),
        connectionId: String(connection._id),
        attemptedCredentialVersion: nextCredentialVersion,
        error: sanitizeAuthError(err),
      }, 'BankConnection reauthorization persistence outcome is uncertain; staged credentials retained');

      throw Errors.Conflict(
        'Bank connection reauthorization outcome is uncertain; staged credentials were retained. Reload connection state before retrying'
      );
    }

    if (!updated) {
      await discardStagedSecret();
      throw Errors.Conflict('Bank connection changed during reauthorization; retry with its current state');
    }

    // The new reference is now authoritative. Old-secret cleanup is best-effort.
    try {
      await deleteConnectionSecret(oldCredentialsRef, {
        ...credentialOwner,
        expectedVersion: oldCredentialVersion,
      });
    } catch {
      logger.error({
        clientId: String(clientId),
        connectionId: String(connection._id),
        retiredCredentialVersion: oldCredentialVersion,
      }, 'Failed to remove retired bank credentials after successful rotation');
    }

    await audit({
      clientId,
      userId,
      action: 'BANK_CONNECTION_REAUTHORIZED',
      resource: 'BankConnection',
      resourceId: updated._id,
      metadata: {
        status: updated.status,
        credentialVersion: updated.credentialVersion,
      },
    });

    return toPublic(updated);
  },

  async disconnect(clientId, connectionId, userId = null) {
    const connection = await this.get(clientId, connectionId);
    connection.status = 'disconnected';
    connection.updatedByUserId = userId;
    connection.authMeta = {
      ...(connection.authMeta?.toObject?.() || connection.authMeta || {}),
      lastAuthError: null,
    };
    await connection.save();
    // Secrets retained until explicit purge policy; stop use via status.
    await audit({
      clientId,
      userId,
      action: 'BANK_CONNECTION_DISCONNECTED',
      resource: 'BankConnection',
      resourceId: connection._id,
      metadata: { provider: connection.provider },
    });
    return toPublic(connection);
  },

  /** Build an adapter only from the current persisted active connection. */
  async getAdapterForConnection(connection) {
    if (!connection?._id) {
      throw Errors.NotFound('Bank connection not found');
    }

    const persisted = await BankConnection.findById(connection._id);
    if (!persisted) {
      throw Errors.NotFound('Bank connection not found');
    }

    // A caller cannot use a connection object belonging to another client.
    if (
      connection.clientId
      && String(connection.clientId) !== String(persisted.clientId)
    ) {
      throw Errors.NotFound('Bank connection not found');
    }

    if (persisted.status === 'disconnected') {
      throw Errors.Conflict('Bank connection is disconnected');
    }
    if (persisted.status !== 'active') {
      throw Errors.BankAuthFailed('Bank connection is not active');
    }

    const credentialVersion = Number(persisted.credentialVersion);
    if (
      !persisted.credentialsRef
      || !Number.isSafeInteger(credentialVersion)
      || credentialVersion < 1
    ) {
      throw Errors.BankAuthFailed('Bank connection credential state is invalid');
    }

    const material = await getConnectionSecret(persisted.credentialsRef, {
      clientId: persisted.clientId,
      provider: persisted.provider,
      expectedVersion: credentialVersion,
    });

    return createBankProviderForConnection(persisted.provider, material, {
      connectionId: String(persisted._id),
      credentialVersion,
    });
  },
};

export { toPublic as toPublicBankConnection };
