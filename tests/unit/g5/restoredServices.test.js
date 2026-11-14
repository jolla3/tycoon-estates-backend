import { rentService } from '../../../src/services/rent.service.js';
import { smsService } from '../../../src/services/sms.service.js';
import fs from 'fs';

describe('service surface that must not regress', () => {
  test('rentService exposes complete responsibilities', () => {
    for (const fn of ['generateChargesForEstate', 'ensureChargesForTenancy', 'ensureChargesForHouse', 'getOrCreateChargeForHouse',
      'outstandingChargesForTenancy', 'outstandingChargesForHouse', 'previousArrears', 'generateForClient', 'houseAccount', 'summary']) {
      expect(typeof rentService[fn]).toBe('function');
    }
    expect(typeof rentService.isTenancyEligibleForPeriod).toBe('function');
  });
  test('rent service applies Tenant credit after billing and never gates it on created > 0', () => {
    const src = fs.readFileSync(new URL('../../../src/services/rent.service.js', import.meta.url), 'utf8');
    expect(src).toContain('autoApplyCredit');
    expect(src).not.toMatch(/if\s*\(\s*created\s*>\s*0\s*\)\s*\{[^}]*autoApplyCredit/s);
    expect(src.length).toBeGreaterThan(20000);
  });
  test('smsService keeps the outbox worker and positive-allowlist claim', () => {
    for (const fn of ['queueSms', 'sendIndividual', 'sendTemplated', 'preview', 'resolveBroadcastRecipients', 'broadcast', '_claimNextBatch', 'processQueuedBatch']) {
      expect(typeof smsService[fn]).toBe('function');
    }
    const src = fs.readFileSync(new URL('../../../src/services/sms.service.js', import.meta.url), 'utf8');
    expect(src).toContain("deliveryMode: 'STANDARD'");
    expect(src).toContain("dispatchMode: 'ENABLED'");
    expect(src).not.toMatch(/deliveryMode:\s*\{\s*\$ne:\s*'G5_PROTECTED'\s*\}/);
    expect(src).toContain('processingStartedAt'); // schema field (claimedAt is not in SmsMessage)
  });
});
