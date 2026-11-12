/**
 * G4 Task 01 — BankConnection model validation and index definitions.
 * Schema-level tests use Mongoose Document#validateSync (no DB required).
 * Index uniqueness policy is asserted from exported specs + schema indexes.
 */
import '../setup.js';
import mongoose from 'mongoose';
import {
  BankConnection,
  BANK_CONNECTION_PROVIDERS,
  BANK_CONNECTION_STATUSES,
  BANK_CONNECTION_INDEX_SPECS,
  sanitizeBankConnection,
} from '../../src/models/BankConnection.js';

const clientId = new mongoose.Types.ObjectId();

function baseAttrs(overrides = {}) {
  return {
    clientId,
    provider: 'COOP',
    credentialsRef: 'secrets://bank/connections/test-ref-001',
    credentialVersion: 1,
    status: 'pending',
    ...overrides,
  };
}

describe('BankConnection model', () => {
  test('exports the preserved provider identifiers without implying operational status', () => {
    expect(BANK_CONNECTION_PROVIDERS).toEqual(['COOP', 'KCB', 'EQUITY', 'NCBA']);
  });

  test('exports connection auth lifecycle statuses distinct from account connectionStatus', () => {
    expect(BANK_CONNECTION_STATUSES).toEqual([
      'pending',
      'active',
      'reauth_required',
      'disconnected',
      'failed',
    ]);
  });

  test('accepts a minimal valid connection', () => {
    const doc = new BankConnection(baseAttrs());
    const err = doc.validateSync();
    expect(err).toBeUndefined();
    expect(doc.credentialVersion).toBe(1);
    expect(doc.status).toBe('pending');
  });

  test('requires clientId, provider, and credentialsRef', () => {
    const missingClient = new BankConnection(baseAttrs({ clientId: undefined }));
    expect(missingClient.validateSync()?.errors?.clientId).toBeTruthy();

    const missingProvider = new BankConnection(baseAttrs({ provider: undefined }));
    expect(missingProvider.validateSync()?.errors?.provider).toBeTruthy();

    const missingRef = new BankConnection(baseAttrs({ credentialsRef: undefined }));
    expect(missingRef.validateSync()?.errors?.credentialsRef).toBeTruthy();
  });

  test('rejects empty credentialsRef', () => {
    const doc = new BankConnection(baseAttrs({ credentialsRef: '   ' }));
    // trim + minlength: after cast, empty string fails required/minlength
    const err = doc.validateSync();
    expect(err?.errors?.credentialsRef).toBeTruthy();
  });

  test('rejects unknown provider identifiers', () => {
    const doc = new BankConnection(baseAttrs({ provider: 'SAFARICOM' }));
    expect(doc.validateSync()?.errors?.provider).toBeTruthy();
  });

  test('accepts every preserved provider identifier at the model layer', () => {
    for (const provider of BANK_CONNECTION_PROVIDERS) {
      const doc = new BankConnection(baseAttrs({ provider }));
      expect(doc.validateSync()).toBeUndefined();
    }
  });

  test('rejects unknown status values', () => {
    const doc = new BankConnection(baseAttrs({ status: 'connected' }));
    // 'connected' is a BankAccount status — not valid on BankConnection
    expect(doc.validateSync()?.errors?.status).toBeTruthy();
  });

  test('credentialVersion must be an integer >= 1', () => {
    expect(new BankConnection(baseAttrs({ credentialVersion: 0 })).validateSync()?.errors?.credentialVersion).toBeTruthy();
    expect(new BankConnection(baseAttrs({ credentialVersion: 1.5 })).validateSync()?.errors?.credentialVersion).toBeTruthy();
    expect(new BankConnection(baseAttrs({ credentialVersion: 2 })).validateSync()).toBeUndefined();
  });

  test('does not define schema paths for access or refresh tokens', () => {
    const paths = Object.keys(BankConnection.schema.paths);
    expect(paths).not.toContain('accessToken');
    expect(paths).not.toContain('refreshToken');
    expect(paths).not.toContain('clientSecret');
    expect(paths).not.toContain('password');
    expect(paths).not.toContain('credentialsEncrypted');
    expect(paths).toContain('credentialsRef');
    expect(paths).toContain('credentialVersion');
  });

  test('authMeta may carry non-secret operational hints only', () => {
    const doc = new BankConnection(baseAttrs({
      authMeta: {
        tokenExpiresAt: new Date('2026-12-01T00:00:00.000Z'),
        lastAuthAt: new Date('2026-11-11T00:00:00.000Z'),
        lastAuthError: 'provider_401',
        externalClientId: 'portal-app-9',
      },
    }));
    expect(doc.validateSync()).toBeUndefined();
    expect(doc.authMeta.externalClientId).toBe('portal-app-9');
  });

  test('toJSON and sanitizeBankConnection omit credentialsRef', () => {
    const doc = new BankConnection(baseAttrs({
      credentialsRef: 'secrets://bank/connections/hidden',
      displayName: 'Ops COOP',
    }));
    const json = doc.toJSON();
    expect(json.credentialsRef).toBeUndefined();
    expect(json.displayName).toBe('Ops COOP');
    expect(json.provider).toBe('COOP');

    const sanitized = sanitizeBankConnection(doc);
    expect(sanitized.credentialsRef).toBeUndefined();
  });
});

describe('BankConnection indexes', () => {
  test('schema indexes are non-unique for clientId+provider (multi-connection support)', () => {
    const indexes = BankConnection.schema.indexes();
    const clientProviderStatus = indexes.find(
      ([key]) => key.clientId === 1 && key.provider === 1 && key.status === 1
    );
    expect(clientProviderStatus).toBeTruthy();
    const opts = clientProviderStatus[1] || {};
    expect(opts.unique).not.toBe(true);

    const uniqueClientProvider = indexes.find(
      ([key, opts]) => key.clientId === 1
        && key.provider === 1
        && key.status === undefined
        && opts?.unique === true
    );
    expect(uniqueClientProvider).toBeUndefined();
  });

  test('exported index specs declare non-unique compound indexes only', () => {
    expect(BANK_CONNECTION_INDEX_SPECS.length).toBeGreaterThanOrEqual(2);
    for (const spec of BANK_CONNECTION_INDEX_SPECS) {
      expect(spec.unique).toBe(false);
      expect(spec.key.clientId).toBe(1);
    }
    const multi = BANK_CONNECTION_INDEX_SPECS.find(
      (s) => s.key.provider === 1 && s.key.status === 1
    );
    expect(multi).toBeTruthy();
    expect(multi.unique).toBe(false);
  });

  test('two documents with the same clientId and provider are valid at schema level', () => {
    const a = new BankConnection(baseAttrs({
      credentialsRef: 'secrets://bank/connections/a',
      displayName: 'Primary',
    }));
    const b = new BankConnection(baseAttrs({
      credentialsRef: 'secrets://bank/connections/b',
      displayName: 'Secondary',
      status: 'active',
      credentialVersion: 3,
    }));
    expect(a.validateSync()).toBeUndefined();
    expect(b.validateSync()).toBeUndefined();
    expect(String(a.clientId)).toBe(String(b.clientId));
    expect(a.provider).toBe(b.provider);
    // Distinct identities are document _ids (assigned on save); schema does not collide.
    expect(a.credentialsRef).not.toBe(b.credentialsRef);
  });
});
