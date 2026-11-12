import '../setup.js';
import mongoose from 'mongoose';
import request from 'supertest';
import {
  jest,
  beforeAll,
  afterAll,
  describe,
  test,
  expect,
} from '@jest/globals';

import {
  describeWithMongo,
  connectTestDb,
  disconnectTestDb,
} from '../helpers/db.js';

import { extractCsrfToken } from '../helpers/csrf.js';

jest.setTimeout(60000);

// Only the external bank-provider boundary is controlled.
// Express, sessions, authentication, CSRF, middleware, controllers,
// services, MongoDB models, credential encryption and persistence are real.

const authenticateProvider = jest.fn().mockResolvedValue(undefined);
const validateProviderAccount = jest.fn().mockResolvedValue({ valid: true });

const assertProviderOperational = jest.fn((provider) => {
  if (String(provider).toUpperCase() !== 'COOP') {
    throw new Error(`Unsupported provider in HTTP integration test: ${provider}`);
  }
});

const getBankProviderCapabilities = jest.fn(() => ({
  implemented: true,
  polling: false,
  statementImport: true,
  balance: true,
  webhook: true,
  accountValidation: true,
}));

const createBankProviderForConnection = jest.fn(() => ({
  authenticate: authenticateProvider,
  validateAccount: validateProviderAccount,
}));

jest.unstable_mockModule(
  '../../src/services/banking/bank.factory.js',
  () => ({
    assertProviderOperational,
    isNonProductionLabOverrideEnabled: jest.fn(
      (enabled, nodeEnv = 'test') =>
        enabled === true && String(nodeEnv).toLowerCase() !== 'production'
    ),
    createBankProviderForConnection,
    getBankProviderCapabilities,
    getProviderReadiness: jest.fn(() => ({
      name: 'COOP',
      operationalReady: false,
      capabilities: {
        webhook: { operationalReady: false },
      },
    })),
  })
);

jest.unstable_mockModule(
  '../../src/services/audit.service.js',
  () => ({
    audit: jest.fn().mockResolvedValue(undefined),
  })
);

const {
  createApp,
  closeAppSessionStores,
} = await import('../../src/app.js');

const { disconnectRedis } =
  await import('../../src/config/redis.js');

const { authService } =
  await import('../../src/services/auth.service.js');

const { BankConnection } =
  await import('../../src/models/BankConnection.js');

const { BankCredential } =
  await import('../../src/models/BankCredential.js');

const { BankAccount } =
  await import('../../src/models/BankAccount.js');

const { Estate } =
  await import('../../src/models/Estate.js');

const { User } =
  await import('../../src/models/User.js');

const { Client } =
  await import('../../src/models/Client.js');

const { Subscription } =
  await import('../../src/models/Subscription.js');

const appClientIds = [];
const appUserIds = [];

let app;
let appCreated = false;

function responseData(response) {
  return response.body?.data ?? response.body?.result ?? response.body;
}

function expectNoCredentialLeak(response, secrets) {
  const serialized = JSON.stringify(response.body);

  for (const secret of secrets) {
    expect(serialized).not.toContain(secret);
  }

  for (const field of [
    'credentialsRef',
    'ciphertext',
    'authTag',
    'accountNumberEncrypted',
    'accountNumberHash',
  ]) {
    expect(serialized).not.toContain(field);
  }
}

async function createTenant(label) {
  const suffix = `${Date.now()}-${process.pid}-${label}`;

  const provisioned = await authService.signup({
    clientName: `G4 HTTP ${label}`,
    ownerName: `G4 Test ${label}`,
    email: `g4-http-${suffix}@example.test`,
    password: 'G4-HTTP-Test-Password-2026!',
  });

  appClientIds.push(provisioned.client._id);
  appUserIds.push(provisioned.owner._id);

  return provisioned;
}

async function loginAs(provisioned) {
  const agent = request.agent(app);

  const response = await agent
    .post('/api/v1/auth/login')
    .send({
      email: provisioned.owner.email,
      password: 'G4-HTTP-Test-Password-2026!',
    })
    .expect(200);

  const csrfToken = extractCsrfToken(response);

  expect(csrfToken).toBeTruthy();

  return { agent, csrfToken };
}

describeWithMongo('G4 bank connection HTTP integration', () => {
  beforeAll(async () => {
    expect(process.env.TYCOON_ALLOW_DESTRUCTIVE_TEST_DB).toBe('1');

    const expectedDatabaseName = process.env.G4_HTTP_TEST_DB_NAME;
    expect(expectedDatabaseName)
      .toMatch(/^tycoon_test_g4_http_[a-z0-9_]{2,32}$/);
    expect(process.env.MONGODB_URI)
      .toContain(`/${expectedDatabaseName}`);

    await connectTestDb();

    expect(mongoose.connection.name).toBe(expectedDatabaseName);

    app = createApp();
    appCreated = true;

    console.log('PASS: isolated MongoDB and real Express application initialized');
  }, 30000);

  afterAll(async () => {
    const cleanupErrors = [];

    try {
      if (appCreated) {
        await closeAppSessionStores();
      }
    } catch (error) {
      cleanupErrors.push(error);
    }

    try {
      // Stops the application's shared ioredis retry loop.
      await disconnectRedis();
    } catch (error) {
      cleanupErrors.push(error);
    }

    try {
      if (appCreated && mongoose.connection.readyState === 1) {
        const expectedDatabaseName = process.env.G4_HTTP_TEST_DB_NAME;

        if (
          !/^tycoon_test_g4_http_[a-z0-9_]{2,32}$/.test(expectedDatabaseName || '')
          || mongoose.connection.name !== expectedDatabaseName
        ) {
          throw new Error('Refusing session cleanup outside this isolated G4 HTTP test database');
        }

        // This database was verified empty before the test. Remove only
        // session documents created by this isolated HTTP test run.
        const sessionResult = await mongoose.connection.db
          .collection('sessions')
          .deleteMany({});

        console.log(
          `PASS: isolated test sessions cleaned (${sessionResult.deletedCount})`
        );
      }

      if (mongoose.connection.readyState === 1 && appClientIds.length) {
        const clientFilter = { $in: appClientIds };

        // Delete only records belonging to this test's generated tenants.
        await BankAccount.deleteMany({ clientId: clientFilter });
        await BankConnection.deleteMany({ clientId: clientFilter });
        await BankCredential.deleteMany({ clientId: clientFilter });
        await Estate.deleteMany({ clientId: clientFilter });
        await Subscription.deleteMany({ clientId: clientFilter });
        await User.deleteMany({ _id: { $in: appUserIds } });
        await Client.deleteMany({ _id: clientFilter });

        console.log('PASS: test-owned MongoDB records cleaned up');
      }
    } catch (error) {
      cleanupErrors.push(error);
    }

    try {
      await disconnectTestDb();
    } catch (error) {
      cleanupErrors.push(error);
    }

    if (cleanupErrors.length) {
      throw new AggregateError(
        cleanupErrors,
        'G4 HTTP integration cleanup failed'
      );
    }

    console.log('PASS: Redis, MongoDB and app session resources closed');
  }, 30000);

  test('unauthenticated bank connection listing is rejected', async () => {
    await request(app)
      .get('/api/v1/bank/connections')
      .expect(401);

    console.log('PASS: unauthenticated HTTP request rejected');
  });

  test('complete authenticated G4 banking HTTP lifecycle', async () => {
    const owner = await createTenant('owner');
    const otherTenant = await createTenant('other');

    const estate = await Estate.create({
      clientId: owner.client._id,
      name: 'G4 HTTP Test Estate',
      currency: 'KES',
    });

    const otherEstate = await Estate.create({
      clientId: otherTenant.client._id,
      name: 'G4 Other Tenant Estate',
      currency: 'KES',
    });

    const ownerSession = await loginAs(owner);
    const otherSession = await loginAs(otherTenant);

    const ownerAgent = ownerSession.agent;
    const csrf = ownerSession.csrfToken;

    const credentialMaterialV1 = {
      clientId: 'g4-http-client-v1',
      clientSecret: 'g4-http-secret-v1',
      username: 'g4-http-user-v1',
      password: 'g4-http-password-v1',
      scope: 'account.read',
    };

    const credentialMaterialV2 = {
      clientId: 'g4-http-client-v2',
      clientSecret: 'g4-http-secret-v2',
      username: 'g4-http-user-v2',
      password: 'g4-http-password-v2',
      scope: 'account.read',
    };

    const knownSecrets = [
      ...Object.values(credentialMaterialV1),
      ...Object.values(credentialMaterialV2),
    ];

    // 1. CSRF enforcement.
    const noCsrf = await ownerAgent
      .post('/api/v1/bank/connections')
      .send({
        provider: 'COOP',
        credentialMaterial: credentialMaterialV1,
      });

    expect(noCsrf.status).toBe(403);

    expect(await BankConnection.countDocuments({
      clientId: owner.client._id,
    })).toBe(0);

    console.log('PASS: missing CSRF rejected without creating a connection');

    // 2. Create a connection through the actual HTTP route.
    // A forged clientId must not override authenticated tenant context.
    const createResponse = await ownerAgent
      .post('/api/v1/bank/connections')
      .set('x-csrf-token', csrf)
      .send({
        clientId: String(otherTenant.client._id),
        provider: 'COOP',
        displayName: 'G4 HTTP connection',
        credentialMaterial: credentialMaterialV1,
      });

    expect(createResponse.status).toBe(201);

    const createdData = responseData(createResponse);
    const connectionId = String(createdData.id || createdData._id || '');

    expect(connectionId).toMatch(/^[a-f0-9]{24}$/i);
    expect(createdData.status).toBe('active');
    expect(createdData.credentialVersion).toBe(1);

    expectNoCredentialLeak(createResponse, knownSecrets);

    const persistedConnection = await BankConnection.findOne({
      _id: connectionId,
      clientId: owner.client._id,
    });

    expect(persistedConnection).not.toBeNull();
    expect(persistedConnection.provider).toBe('COOP');
    expect(persistedConnection.status).toBe('active');
    expect(persistedConnection.credentialVersion).toBe(1);

    const originalCredentialsRef = persistedConnection.credentialsRef;

    expect(originalCredentialsRef).toBeTruthy();

    const originalCredential = await BankCredential.findOne({
      _id: originalCredentialsRef,
      clientId: owner.client._id,
      provider: 'COOP',
      credentialVersion: 1,
    });

    expect(originalCredential).not.toBeNull();
    expect(originalCredential.envelope.algorithm).toBe('aes-256-gcm');

    const storedEnvelope = JSON.stringify(originalCredential.envelope);

    for (const secret of knownSecrets.slice(0, 5)) {
      expect(storedEnvelope).not.toContain(secret);
    }

    expect(createBankProviderForConnection).toHaveBeenCalledWith(
      'COOP',
      credentialMaterialV1,
      expect.objectContaining({
        connectionId,
        credentialVersion: 1,
      })
    );

    console.log('PASS: HTTP create persists encrypted credentials for authenticated tenant');

    // 3. List and retrieve.
    const listResponse = await ownerAgent
      .get('/api/v1/bank/connections')
      .expect(200);

    const listed = responseData(listResponse);

    expect(Array.isArray(listed)).toBe(true);
    expect(
      listed.some((item) => String(item.id || item._id) === connectionId)
    ).toBe(true);

    expectNoCredentialLeak(listResponse, knownSecrets);

    const detailResponse = await ownerAgent
      .get(`/api/v1/bank/connections/${connectionId}`)
      .expect(200);

    expect(responseData(detailResponse).status).toBe('active');
    expectNoCredentialLeak(detailResponse, knownSecrets);

    console.log('PASS: connection list and detail routes redact secrets and references');

    // 4. Cross-tenant connection access.
    await otherSession.agent
      .get(`/api/v1/bank/connections/${connectionId}`)
      .expect(404);

    console.log('PASS: cross-tenant connection lookup rejected');

    // 5. Link a physical bank account through the real bank route.
    const accountNumber = `9${String(Date.now()).slice(-13)}`;

    const linkResponse = await ownerAgent
      .post('/api/v1/bank/accounts')
      .set('x-csrf-token', csrf)
      .send({
        clientId: String(otherTenant.client._id),
        estateId: String(estate._id),
        connectionId,
        provider: 'COOP',
        accountNumber,
        accountName: 'G4 HTTP Test Account',
        currency: 'KES',
      });

    expect(linkResponse.status).toBe(201);
    expectNoCredentialLeak(linkResponse, knownSecrets);

    const linkedAccount = await BankAccount.findOne({
      clientId: owner.client._id,
      provider: 'COOP',
    });

    expect(linkedAccount).not.toBeNull();
    expect(String(linkedAccount.estateId)).toBe(String(estate._id));
    expect(String(linkedAccount.connectionId)).toBe(connectionId);
    expect(linkedAccount.connectionStatus).toBe('connected');
    expect(linkedAccount.validationStatus).toBe('validated');
    expect(linkedAccount.accountNumberEncrypted).not.toBe(accountNumber);
    expect(linkedAccount.accountNumberHash).toBeTruthy();

    expect(JSON.stringify(linkResponse.body)).not.toContain(accountNumber);

    console.log('PASS: bank account linked after controlled provider validation');

    // 6. Cross-tenant account-link attempt.
    const otherTenantLink = await otherSession.agent
      .post('/api/v1/bank/accounts')
      .set('x-csrf-token', otherSession.csrfToken)
      .send({
        estateId: String(otherEstate._id),
        connectionId,
        provider: 'COOP',
        accountNumber: `8${String(Date.now()).slice(-13)}`,
        accountName: 'Cross-tenant attempt',
        currency: 'KES',
      });

    expect(otherTenantLink.status).toBeGreaterThanOrEqual(400);

    expect(await BankAccount.countDocuments({
      clientId: otherTenant.client._id,
    })).toBe(0);

    console.log('PASS: cross-tenant account linking rejected');

    // 7. Failed reauthorization must preserve version 1.
    authenticateProvider.mockRejectedValueOnce(
      new Error('Controlled provider authentication rejection')
    );

    const failedRotation = await ownerAgent
      .post(`/api/v1/bank/connections/${connectionId}/reauthorize`)
      .set('x-csrf-token', csrf)
      .send({
        credentialMaterial: credentialMaterialV2,
      });

    expect(failedRotation.status).toBeGreaterThanOrEqual(400);

    const afterFailedRotation = await BankConnection.findById(connectionId);

    expect(afterFailedRotation.credentialsRef).toBe(originalCredentialsRef);
    expect(afterFailedRotation.credentialVersion).toBe(1);
    expect(afterFailedRotation.status).toBe('active');

    expect(await BankCredential.countDocuments({
      clientId: owner.client._id,
    })).toBe(1);

    console.log('PASS: failed HTTP reauthorization preserves original credential');

    // 8. Successful reauthorization promotes version 2.
    const successfulRotation = await ownerAgent
      .post(`/api/v1/bank/connections/${connectionId}/reauthorize`)
      .set('x-csrf-token', csrf)
      .send({
        credentialMaterial: credentialMaterialV2,
      })
      .expect(200);

    const rotatedData = responseData(successfulRotation);

    expect(rotatedData.status).toBe('active');
    expect(rotatedData.credentialVersion).toBe(2);
    expectNoCredentialLeak(successfulRotation, knownSecrets);

    const afterSuccessfulRotation =
      await BankConnection.findById(connectionId);

    expect(afterSuccessfulRotation.credentialVersion).toBe(2);
    expect(afterSuccessfulRotation.credentialsRef)
      .not.toBe(originalCredentialsRef);

    expect(
      await BankCredential.findOne({ _id: originalCredentialsRef })
    ).toBeNull();

    const currentCredential = await BankCredential.findOne({
      _id: afterSuccessfulRotation.credentialsRef,
      clientId: owner.client._id,
      provider: 'COOP',
      credentialVersion: 2,
    });

    expect(currentCredential).not.toBeNull();

    console.log('PASS: successful HTTP reauthorization promotes version 2');

    // 9. Disconnect blocks new account linking but retains credentials.
    const disconnectResponse = await ownerAgent
      .post(`/api/v1/bank/connections/${connectionId}/disconnect`)
      .set('x-csrf-token', csrf)
      .expect(200);

    expect(responseData(disconnectResponse).status).toBe('disconnected');

    expect(
      await BankCredential.findOne({
        _id: afterSuccessfulRotation.credentialsRef,
        clientId: owner.client._id,
      })
    ).not.toBeNull();

    const afterDisconnectLink = await ownerAgent
      .post('/api/v1/bank/accounts')
      .set('x-csrf-token', csrf)
      .send({
        estateId: String(estate._id),
        connectionId,
        provider: 'COOP',
        accountNumber: `7${String(Date.now()).slice(-13)}`,
        accountName: 'Disconnected connection attempt',
        currency: 'KES',
      });

    expect(afterDisconnectLink.status).toBeGreaterThanOrEqual(400);

    expect(await BankAccount.countDocuments({
      clientId: owner.client._id,
    })).toBe(1);

    console.log('PASS: disconnected connection blocks account linking and retains credentials');

    // 10. Disconnected connection cannot be reauthorized.
    const reauthorizeDisconnected = await ownerAgent
      .post(`/api/v1/bank/connections/${connectionId}/reauthorize`)
      .set('x-csrf-token', csrf)
      .send({
        credentialMaterial: credentialMaterialV2,
      });

    expect(reauthorizeDisconnected.status).toBeGreaterThanOrEqual(400);

    expect(await BankConnection.findById(connectionId)).toMatchObject({
      status: 'disconnected',
      credentialVersion: 2,
    });

    console.log('RESULT: complete G4 HTTP and MongoDB lifecycle passed');
  }, 60000);
});
