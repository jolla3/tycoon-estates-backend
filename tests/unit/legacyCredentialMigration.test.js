import { jest } from '@jest/globals';

import {
  buildLegacyCredentialMigrationPlan,
  assertLegacyDestinationKeyringsDistinct,
  runLegacyCredentialMigration,
} from '../../src/services/banking/legacyCredentialMigration.js';

const CONNECTION_A = {
  _id: '64b000000000000000000001',
  clientId: '64b000000000000000000010',
  provider: 'COOP',
  credentialsRef: 'secrets://bank/connections/coop/client-a/ref-a',
  credentialVersion: 3,
  status: 'active',
  updatedAt: new Date('2026-11-11T10:00:00.000Z'),
};

const CONNECTION_B = {
  _id: '64b000000000000000000002',
  clientId: '64b000000000000000000020',
  provider: 'COOP',
  credentialsRef: 'secrets://bank/connections/coop/client-b/ref-b',
  credentialVersion: 2,
  status: 'disconnected',
  updatedAt: new Date('2026-11-11T11:00:00.000Z'),
};

const MATERIAL = {
  clientId: 'provider-client',
  clientSecret: 'fixture-secret',
  username: 'fixture-user',
  password: 'fixture-password',
};

function makeHarness(overrides = {}) {
  let inventory = [structuredClone(CONNECTION_A)];

  const loadInventory = jest.fn(async () => structuredClone(inventory));
  const readCurrentConnection = jest.fn(async (id) =>
    structuredClone(inventory.find((row) => String(row._id) === id) || null)
  );
  const inspectDestinationCredential = jest.fn(async () => ({ status: 'absent' }));
  const readLegacyCredential = jest.fn(async (entry) => ({
    material: structuredClone(MATERIAL),
    credentialVersion: entry.credentialVersion,
    updatedAt: '2026-11-11T12:00:00.000Z',
  }));
  const importConnectionSecret = jest.fn(async () => ({ status: 'imported' }));

  return {
    setInventory(rows) {
      inventory = structuredClone(rows);
    },
    loadInventory,
    readCurrentConnection,
    inspectDestinationCredential,
    readLegacyCredential,
    importConnectionSecret,
    dependencies(extra = {}) {
      return {
        inventory: structuredClone(inventory),
        loadInventory,
        readCurrentConnection,
        inspectDestinationCredential,
        readLegacyCredential,
        importConnectionSecret,
        ...overrides,
        ...extra,
      };
    },
  };
}

describe('legacy credential migration plan', () => {
  test('fingerprint is independent of database query ordering', () => {
    const a = buildLegacyCredentialMigrationPlan([CONNECTION_A, CONNECTION_B]);
    const b = buildLegacyCredentialMigrationPlan([CONNECTION_B, CONNECTION_A]);

    expect(a.fingerprint).toMatch(/^[a-f0-9]{64}$/);
    expect(a.fingerprint).toBe(b.fingerprint);
    expect(a.total).toBe(2);
  });

  test('fingerprint changes when credential identity or lifecycle changes', () => {
    const original = buildLegacyCredentialMigrationPlan([CONNECTION_A]);
    const changedVersion = buildLegacyCredentialMigrationPlan([{
      ...CONNECTION_A,
      credentialVersion: 4,
    }]);
    const changedStatus = buildLegacyCredentialMigrationPlan([{
      ...CONNECTION_A,
      status: 'disconnected',
    }]);

    expect(original.fingerprint).not.toBe(changedVersion.fingerprint);
    expect(original.fingerprint).not.toBe(changedStatus.fingerprint);
  });

  test('marks every connection sharing one credential reference as a conflict', () => {
    const plan = buildLegacyCredentialMigrationPlan([
      CONNECTION_A,
      {
        ...CONNECTION_B,
        credentialsRef: CONNECTION_A.credentialsRef,
      },
    ]);

    expect(plan.duplicateReferenceGroups).toBe(1);
    expect(plan.entries.every((entry) => entry.duplicateReference)).toBe(true);
  });

  test('does not expose credential references in the fingerprint', () => {
    const plan = buildLegacyCredentialMigrationPlan([CONNECTION_A]);

    expect(plan.fingerprint).not.toContain(CONNECTION_A.credentialsRef);
  });

  test('rejects a non-array inventory', () => {
    expect(() => buildLegacyCredentialMigrationPlan(null))
      .toThrow(/must be an array/i);
  });
});

describe('legacy and destination keyring separation', () => {
  test('accepts independent current and previous keyrings', () => {
    expect(assertLegacyDestinationKeyringsDistinct({
      legacyCurrentKeyHex: '11'.repeat(32),
      legacyPreviousKeyHex: '22'.repeat(32),
      destinationCurrentKeyHex: '33'.repeat(32),
      destinationPreviousKeyHex: '44'.repeat(32),
    })).toBe(true);
  });

  test('rejects a key reused across source and destination', () => {
    expect(() => assertLegacyDestinationKeyringsDistinct({
      legacyCurrentKeyHex: '11'.repeat(32),
      legacyPreviousKeyHex: '22'.repeat(32),
      destinationCurrentKeyHex: '11'.repeat(32),
      destinationPreviousKeyHex: '44'.repeat(32),
    })).toThrow(/keyrings must be distinct/i);
  });

  test('rejects case-variant duplicate keys', () => {
    expect(() => assertLegacyDestinationKeyringsDistinct({
      legacyCurrentKeyHex: 'AA'.repeat(32),
      destinationCurrentKeyHex: 'aa'.repeat(32),
    })).toThrow(/keyrings must be distinct/i);
  });

  test('rejects duplicate previous and current keys within one keyring', () => {
    expect(() => assertLegacyDestinationKeyringsDistinct({
      legacyCurrentKeyHex: '11'.repeat(32),
      legacyPreviousKeyHex: '11'.repeat(32),
      destinationCurrentKeyHex: '22'.repeat(32),
    })).toThrow(/legacy current and previous/i);
  });

  test('rejects malformed key material without printing it', () => {
    expect(() => assertLegacyDestinationKeyringsDistinct({
      legacyCurrentKeyHex: 'not-a-key',
      destinationCurrentKeyHex: '22'.repeat(32),
    })).toThrow(/exactly 64 hexadecimal/i);
  });
});

describe('legacy credential migration coordinator', () => {
  test('dry-run validates source material but never calls the importer', async () => {
    const h = makeHarness();

    const result = await runLegacyCredentialMigration(
      h.dependencies({ mode: 'dry-run' })
    );

    expect(result.complete).toBe(true);
    expect(result.counts.ready_to_import).toBe(1);
    expect(h.readLegacyCredential).toHaveBeenCalledTimes(1);
    expect(h.importConnectionSecret).not.toHaveBeenCalled();
  });

  test('execute imports under the exact original reference, owner, provider and version', async () => {
    const h = makeHarness();
    const plan = buildLegacyCredentialMigrationPlan([CONNECTION_A]);

    const result = await runLegacyCredentialMigration(
      h.dependencies({
        mode: 'execute',
        expectedInventoryFingerprint: plan.fingerprint,
      })
    );

    expect(result.complete).toBe(true);
    expect(result.counts.imported).toBe(1);
    expect(h.importConnectionSecret).toHaveBeenCalledWith(
      CONNECTION_A.credentialsRef,
      MATERIAL,
      {
        clientId: CONNECTION_A.clientId,
        provider: 'COOP',
        credentialVersion: 3,
      }
    );
  });

  test('execute refuses a stale dry-run inventory fingerprint', async () => {
    const h = makeHarness();

    await expect(
      runLegacyCredentialMigration(
        h.dependencies({
          mode: 'execute',
          expectedInventoryFingerprint: '0'.repeat(64),
        })
      )
    ).rejects.toThrow(/fingerprint does not match/i);

    expect(h.importConnectionSecret).not.toHaveBeenCalled();
  });

  test('recognizes an already valid destination credential without reading Redis', async () => {
    const h = makeHarness();
    h.inspectDestinationCredential.mockResolvedValueOnce({
      status: 'present',
    });

    const result = await runLegacyCredentialMigration(
      h.dependencies({ mode: 'dry-run' })
    );

    expect(result.counts.already_present).toBe(1);
    expect(h.readLegacyCredential).not.toHaveBeenCalled();
    expect(h.importConnectionSecret).not.toHaveBeenCalled();
  });

  test('rejects an invalid destination record without falling back to Redis', async () => {
    const h = makeHarness();
    h.inspectDestinationCredential.mockResolvedValueOnce({
      status: 'invalid',
    });

    const plan = buildLegacyCredentialMigrationPlan([CONNECTION_A]);
    const result = await runLegacyCredentialMigration(
      h.dependencies({
        mode: 'execute',
        expectedInventoryFingerprint: plan.fingerprint,
      })
    );

    expect(result.counts.destination_invalid).toBe(1);
    expect(result.complete).toBe(false);
    expect(h.readLegacyCredential).not.toHaveBeenCalled();
    expect(h.importConnectionSecret).not.toHaveBeenCalled();
  });

  test('classifies a missing legacy Redis key for a missing destination', async () => {
    const h = makeHarness();
    h.readLegacyCredential.mockRejectedValueOnce({
      code: 'LEGACY_CREDENTIAL_MISSING',
    });

    const result = await runLegacyCredentialMigration(
      h.dependencies({ mode: 'dry-run' })
    );

    expect(result.counts.source_missing).toBe(1);
    expect(result.complete).toBe(false);
    expect(h.importConnectionSecret).not.toHaveBeenCalled();
  });

  test('halts on an unexpected source reader failure', async () => {
    const h = makeHarness();
    h.setInventory([CONNECTION_A, CONNECTION_B]);
    h.readLegacyCredential.mockRejectedValueOnce(
      new Error('unexpected reader failure')
    );

    const result = await runLegacyCredentialMigration(
      h.dependencies({ mode: 'dry-run' })
    );

    expect(result.counts.source_read_error).toBe(1);
    expect(result.halted).toBe(true);
    expect(result.complete).toBe(false);
    expect(h.readLegacyCredential).toHaveBeenCalledTimes(1);
    expect(h.readCurrentConnection).toHaveBeenCalledTimes(1);
    expect(h.importConnectionSecret).not.toHaveBeenCalled();
  });

  test('rejects a legacy version that differs from the connection version', async () => {
    const h = makeHarness();
    h.readLegacyCredential.mockResolvedValueOnce({
      material: MATERIAL,
      credentialVersion: 2,
    });

    const plan = buildLegacyCredentialMigrationPlan([CONNECTION_A]);
    const result = await runLegacyCredentialMigration(
      h.dependencies({
        mode: 'execute',
        expectedInventoryFingerprint: plan.fingerprint,
      })
    );

    expect(result.counts.version_mismatch).toBe(1);
    expect(result.complete).toBe(false);
    expect(h.importConnectionSecret).not.toHaveBeenCalled();
  });

  test('rejects duplicate references before reading any credential', async () => {
    const h = makeHarness();
    const duplicate = {
      ...CONNECTION_B,
      credentialsRef: CONNECTION_A.credentialsRef,
    };
    h.setInventory([CONNECTION_A, duplicate]);

    const result = await runLegacyCredentialMigration(
      h.dependencies({ mode: 'dry-run' })
    );

    expect(result.counts.duplicate_reference).toBe(2);
    expect(h.readLegacyCredential).not.toHaveBeenCalled();
    expect(h.importConnectionSecret).not.toHaveBeenCalled();
  });

  test('detects a connection changed before its source is read', async () => {
    const h = makeHarness();
    h.readCurrentConnection.mockResolvedValueOnce({
      ...CONNECTION_A,
      credentialVersion: 4,
    });

    const plan = buildLegacyCredentialMigrationPlan([CONNECTION_A]);
    const result = await runLegacyCredentialMigration(
      h.dependencies({
        mode: 'execute',
        expectedInventoryFingerprint: plan.fingerprint,
      })
    );

    expect(result.counts.inventory_changed).toBe(1);
    expect(result.complete).toBe(false);
    expect(h.readLegacyCredential).not.toHaveBeenCalled();
    expect(h.importConnectionSecret).not.toHaveBeenCalled();
  });

  test('detects inventory drift after completed imports without deleting them', async () => {
    const h = makeHarness();
    // The coordinator performs one final inventory reload after processing.
    h.loadInventory.mockResolvedValueOnce([{
      ...CONNECTION_A,
      credentialVersion: 4,
    }]);

    const plan = buildLegacyCredentialMigrationPlan([CONNECTION_A]);
    const result = await runLegacyCredentialMigration(
      h.dependencies({
        mode: 'execute',
        expectedInventoryFingerprint: plan.fingerprint,
      })
    );

    expect(h.importConnectionSecret).toHaveBeenCalledTimes(1);
    expect(result.counts.imported).toBe(1);
    expect(result.counts.inventory_changed).toBe(1);
    expect(result.complete).toBe(false);
  });

  test('execute halts on a known source failure after preflight', async () => {
    const h = makeHarness();
    h.setInventory([CONNECTION_A, CONNECTION_B]);
    h.readLegacyCredential.mockRejectedValueOnce({
      code: 'LEGACY_CREDENTIAL_MISSING',
    });

    const plan = buildLegacyCredentialMigrationPlan([
      CONNECTION_A,
      CONNECTION_B,
    ]);
    const result = await runLegacyCredentialMigration(
      h.dependencies({
        mode: 'execute',
        expectedInventoryFingerprint: plan.fingerprint,
      })
    );

    expect(result.counts.source_missing).toBe(1);
    expect(result.halted).toBe(true);
    expect(result.complete).toBe(false);
    expect(h.readLegacyCredential).toHaveBeenCalledTimes(1);
    expect(h.importConnectionSecret).not.toHaveBeenCalled();
  });

  test('execute halts on malformed source material', async () => {
    const h = makeHarness();
    h.setInventory([CONNECTION_A, CONNECTION_B]);
    h.readLegacyCredential.mockResolvedValueOnce({
      material: [],
      credentialVersion: 3,
    });

    const plan = buildLegacyCredentialMigrationPlan([
      CONNECTION_A,
      CONNECTION_B,
    ]);
    const result = await runLegacyCredentialMigration(
      h.dependencies({
        mode: 'execute',
        expectedInventoryFingerprint: plan.fingerprint,
      })
    );

    expect(result.counts.malformed_record).toBe(1);
    expect(result.halted).toBe(true);
    expect(h.readLegacyCredential).toHaveBeenCalledTimes(1);
    expect(h.importConnectionSecret).not.toHaveBeenCalled();
  });

  test('execute halts on a destination identity conflict', async () => {
    const h = makeHarness();
    h.setInventory([CONNECTION_A, CONNECTION_B]);
    h.inspectDestinationCredential.mockResolvedValueOnce({
      status: 'conflict',
    });

    const plan = buildLegacyCredentialMigrationPlan([
      CONNECTION_A,
      CONNECTION_B,
    ]);
    const result = await runLegacyCredentialMigration(
      h.dependencies({
        mode: 'execute',
        expectedInventoryFingerprint: plan.fingerprint,
      })
    );

    expect(result.counts.destination_conflict).toBe(1);
    expect(result.halted).toBe(true);
    expect(h.readLegacyCredential).not.toHaveBeenCalled();
    expect(h.importConnectionSecret).not.toHaveBeenCalled();
  });

  test('execute rejects duplicate references before reading or importing any credential', async () => {
    const h = makeHarness();
    const duplicate = {
      ...CONNECTION_B,
      credentialsRef: CONNECTION_A.credentialsRef,
    };
    h.setInventory([CONNECTION_A, duplicate]);

    const plan = buildLegacyCredentialMigrationPlan([
      CONNECTION_A,
      duplicate,
    ]);
    const result = await runLegacyCredentialMigration(
      h.dependencies({
        mode: 'execute',
        expectedInventoryFingerprint: plan.fingerprint,
      })
    );

    expect(result.counts.duplicate_reference).toBe(2);
    expect(result.halted).toBe(true);
    expect(result.complete).toBe(false);
    expect(h.readCurrentConnection).not.toHaveBeenCalled();
    expect(h.readLegacyCredential).not.toHaveBeenCalled();
    expect(h.importConnectionSecret).not.toHaveBeenCalled();
  });

  test('execute rejects an invalid later inventory row before importing an earlier valid row', async () => {
    const h = makeHarness();
    const invalidLaterConnection = {
      ...CONNECTION_B,
      status: 'unsupported_status',
    };
    h.setInventory([CONNECTION_A, invalidLaterConnection]);

    const plan = buildLegacyCredentialMigrationPlan([
      CONNECTION_A,
      invalidLaterConnection,
    ]);
    const result = await runLegacyCredentialMigration(
      h.dependencies({
        mode: 'execute',
        expectedInventoryFingerprint: plan.fingerprint,
      })
    );

    expect(result.counts.invalid_identity).toBe(1);
    expect(result.halted).toBe(true);
    expect(result.complete).toBe(false);
    expect(h.readCurrentConnection).not.toHaveBeenCalled();
    expect(h.readLegacyCredential).not.toHaveBeenCalled();
    expect(h.importConnectionSecret).not.toHaveBeenCalled();
  });

  test('does not import when the connection changes after source decryption', async () => {
    const h = makeHarness();
    h.setInventory([CONNECTION_A]);

    h.readCurrentConnection
      .mockResolvedValueOnce(structuredClone(CONNECTION_A))
      .mockResolvedValueOnce({
        ...CONNECTION_A,
        credentialVersion: 4,
      });

    const plan = buildLegacyCredentialMigrationPlan([CONNECTION_A]);
    const result = await runLegacyCredentialMigration(
      h.dependencies({
        mode: 'execute',
        expectedInventoryFingerprint: plan.fingerprint,
      })
    );

    expect(h.readLegacyCredential).toHaveBeenCalledTimes(1);
    expect(h.readCurrentConnection).toHaveBeenCalledTimes(2);
    expect(result.counts.inventory_changed).toBe(1);
    expect(result.inventoryStable).toBe(false);
    expect(result.halted).toBe(true);
    expect(h.importConnectionSecret).not.toHaveBeenCalled();
  });

  test('halts after an uncertain import outcome', async () => {
    const h = makeHarness();
    h.setInventory([CONNECTION_A, CONNECTION_B]);
    h.importConnectionSecret.mockRejectedValueOnce({
      code: 'CONFLICT',
    });

    const plan = buildLegacyCredentialMigrationPlan([
      CONNECTION_A,
      CONNECTION_B,
    ]);

    const result = await runLegacyCredentialMigration(
      h.dependencies({
        mode: 'execute',
        expectedInventoryFingerprint: plan.fingerprint,
      })
    );

    expect(result.counts.import_error).toBe(1);
    expect(result.halted).toBe(true);
    expect(h.importConnectionSecret).toHaveBeenCalledTimes(1);
  });

  test('rejects malformed legacy material without importing it', async () => {
    const h = makeHarness();
    h.readLegacyCredential.mockResolvedValueOnce({
      material: [],
      credentialVersion: 3,
    });

    const result = await runLegacyCredentialMigration(
      h.dependencies({ mode: 'dry-run' })
    );

    expect(result.counts.malformed_record).toBe(1);
    expect(h.importConnectionSecret).not.toHaveBeenCalled();
  });

  test('includes disconnected connections in the inventory', async () => {
    const h = makeHarness();
    h.setInventory([CONNECTION_B]);

    const result = await runLegacyCredentialMigration(
      h.dependencies({ mode: 'dry-run' })
    );

    expect(result.total).toBe(1);
    expect(result.counts.ready_to_import).toBe(1);
    expect(h.readCurrentConnection).toHaveBeenCalledWith(CONNECTION_B._id);
  });
});
