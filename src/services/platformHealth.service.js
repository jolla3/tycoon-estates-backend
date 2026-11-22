// src/services/platformHealth.service.js
//
// Superadmin V2 — platform health with explicit EVIDENCE, no false-green.
//
// Hard rules:
//  * No live provider request is made to populate this report (no Co-op/Daraja/Celcom calls).
//  * Config presence is reported as "configured", never as "operational".
//  * Provider-accepted evidence comes from our own stored records (BankConnection.authMeta,
//    SmsMessage, MpesaIngestionEvent); where none exists the field is `null`/'not_recorded'.
//  * Handset delivery is NOT known: Celcom delivery receipts are not stored, so `sent`
//    means provider-accepted only.
//  * Never exposes secrets, keys, tokens or credential values — booleans/timestamps only.
import { isDatabaseReady, supportsMongoTransactions } from '../config/database.js';
import { checkRedisHealth } from '../config/redis.js';
import { env } from '../config/environment.js';
import { getBackgroundJobStatus } from '../jobs/scheduler.js';
import { BankConnection } from '../models/BankConnection.js';
import { SmsMessage } from '../models/SmsMessage.js';
import { MpesaIngestionEvent } from '../models/MpesaIngestionEvent.js';
import { MpesaMerchantProfile } from '../models/MpesaMerchantProfile.js';
import { INGESTION_SOURCE } from './mpesa/daraja.constants.js';

const safe = async (fn, fallback = null) => {
  try { return await fn(); } catch (_e) { return fallback; }
};

async function bankingHealth(mongoReady) {
  const coopConfigured = Boolean(
    env.COOP_BASE_URL && env.COOP_TOKEN_PATH && env.COOP_TOKEN_GRANT_TYPE
  );
  let clientConnections = null;
  let lastAuthAt = null;
  if (mongoReady) {
    const rows = await safe(() => BankConnection.aggregate([
      { $group: { _id: '$status', count: { $sum: 1 }, lastAuthAt: { $max: '$authMeta.lastAuthAt' } } },
    ]), null);
    if (rows) {
      clientConnections = Object.fromEntries(rows.map((r) => [r._id, r.count]));
      lastAuthAt = rows.map((r) => r.lastAuthAt).filter(Boolean).sort((a, b) => b - a)[0] || null;
    }
  }
  return {
    providers: [
      {
        name: 'COOP',
        adapterImplemented: true,
        providerConfigPresent: coopConfigured,
        insWebhookSecretConfigured: Boolean(env.COOP_INS_BASIC_SECRET),
        // Provider verification is not recorded anywhere by this system.
        providerVerified: null,
        operationalCapability: 'unverified',
        note: 'Adapter exists and configuration may be present; live Co-op readiness is not proven by this report.',
      },
      ...['KCB', 'EQUITY', 'NCBA'].map((name) => ({
        name, adapterImplemented: false, providerConfigPresent: false, providerVerified: false, operationalCapability: 'not_implemented',
      })),
    ],
    clientConnections,
    authEvidence: { lastRecordedClientAuthAt: lastAuthAt, source: 'BankConnection.authMeta.lastAuthAt' },
  };
}

async function mpesaHealth(mongoReady) {
  const platformConfig = Boolean(env.DARAJA_CONSUMER_KEY && env.DARAJA_CONSUMER_SECRET);
  let profiles = null;
  let ingestion = null;
  if (mongoReady) {
    profiles = await safe(async () => {
      const [state, cb, pull] = await Promise.all([
        MpesaMerchantProfile.aggregate([{ $group: { _id: '$operationalState', count: { $sum: 1 } } }]),
        MpesaMerchantProfile.aggregate([{ $group: { _id: '$callbackCapability', count: { $sum: 1 } } }]),
        MpesaMerchantProfile.aggregate([{ $group: { _id: '$pullCapability', count: { $sum: 1 } } }]),
      ]);
      const m = (rows) => Object.fromEntries(rows.map((r) => [r._id, r.count]));
      return { operationalStates: m(state), callbackCapabilities: m(cb), pullCapabilities: m(pull) };
    });
    ingestion = await safe(async () => {
      const rows = await MpesaIngestionEvent.aggregate([
        { $group: { _id: '$sourceChannel', lastReceivedAt: { $max: '$receivedAt' }, total: { $sum: 1 } } },
      ]);
      return Object.fromEntries(rows.map((r) => [r._id, { lastReceivedAt: r.lastReceivedAt, total: r.total }]));
    });
  }
  return {
    // Tycoon-owned Daraja application credentials. Presence only.
    platformApp: { environment: env.DARAJA_ENVIRONMENT, consumerCredentialsConfigured: platformConfig },
    // No OAuth outcome is persisted by the system; do not claim success.
    oauthEvidence: { recorded: false, note: 'No persisted OAuth result; platform OAuth success would not authorize any client Till.' },
    featureFlags: {
      callbacksEnabled: env.DARAJA_CALLBACKS_ENABLED === '1',
      pullReconciliationEnabled: env.DARAJA_PULL_RECONCILIATION_ENABLED === '1',
      submissionsEnabled: env.G5_SUBMISSIONS_ENABLED === '1',
      protectedSmsEnabled: env.G5_PROTECTED_SMS_ENABLED === '1',
    },
    clientMerchantProfiles: profiles,
    // Per-Till authorization is only provider-verified when a profile has VERIFIED capability
    // set by an explicit ops gate; see merchant profiles for that evidence.
    providerVerifiedMerchantAuthorization: profiles ? (profiles.callbackCapabilities?.VERIFIED || 0) + (profiles.pullCapabilities?.VERIFIED || 0) > 0 : null,
    operationalIngestionEvidence: ingestion
      ? Object.fromEntries(Object.values(INGESTION_SOURCE).map((ch) => [ch, ingestion[ch] || { lastReceivedAt: null, total: 0 }]))
      : null,
  };
}

async function smsHealth(mongoReady) {
  const required = {
    baseUrl: Boolean(env.CELCOM_BASE_URL),
    partnerId: Boolean(env.CELCOM_PARTNER_ID),
    apiKey: Boolean(env.CELCOM_API_KEY),
    senderId: Boolean(env.CELCOM_SENDER_ID),
  };
  let evidence = null;
  if (mongoReady) {
    evidence = await safe(async () => {
      const since = new Date(Date.now() - 24 * 60 * 60 * 1000);
      const [byStatus, lastSent, lastFailed] = await Promise.all([
        SmsMessage.aggregate([{ $match: { createdAt: { $gte: since } } }, { $group: { _id: '$status', count: { $sum: 1 } } }]),
        SmsMessage.findOne({ status: 'sent' }).sort({ sentAt: -1 }).select('sentAt').lean(),
        SmsMessage.findOne({ status: 'failed' }).sort({ failedAt: -1 }).select('failedAt').lean(),
      ]);
      return {
        last24hByStatus: Object.fromEntries(byStatus.map((r) => [r._id, r.count])),
        lastProviderAcceptedAt: lastSent?.sentAt || null,
        lastFailureAt: lastFailed?.failedAt || null,
      };
    });
  }
  return {
    provider: 'CELCOM',
    adapterImplemented: true,
    configured: Object.values(required).every(Boolean),
    requiredConfig: required,
    // 'sent' = accepted by Celcom. Handset delivery receipts are not stored.
    providerAcceptanceEvidence: evidence,
    handsetDeliveryTracked: false,
  };
}

export async function getPlatformHealth() {
  const mongoReady = isDatabaseReady();
  const redis = await checkRedisHealth(400);
  const [banking, mpesa, sms, scheduler] = await Promise.all([
    bankingHealth(mongoReady),
    mpesaHealth(mongoReady),
    smsHealth(mongoReady),
    safe(() => getBackgroundJobStatus(), null),
  ]);
  return {
    generatedAt: new Date().toISOString(),
    application: {
      processUp: true,
      uptimeSeconds: Math.round(process.uptime()),
      nodeEnv: env.NODE_ENV,
      // required() config is validated at boot; the process would not be serving otherwise.
      requiredConfigValidatedAtBoot: true,
    },
    mongo: {
      status: mongoReady ? 'healthy' : 'unhealthy',
      connected: mongoReady,
      // null = not yet verified (fail-closed), true/false = verified from live hello.
      transactionSupport: supportsMongoTransactions(),
    },
    redis: { status: redis.status, latencyMs: redis.latencyMs ?? null },
    scheduler,
    banking,
    mpesa,
    sms,
  };
}
