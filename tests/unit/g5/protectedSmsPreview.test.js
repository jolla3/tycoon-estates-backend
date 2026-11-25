import '../../setup.js';
import { jest, describe, test, expect } from '@jest/globals';
import { sealEnvelope } from '../../../src/utils/g5Envelope.js';

process.env.G5_ENVELOPE_KEYS = `k1:${'a'.repeat(64)}`;
const { buildProtectedSmsAad, protectedSmsHistoryPreview, protectedSmsHistoryDetails } = await import('../../../src/services/g5ProtectedSms.service.js');

function encryptedRow(body) {
  const row = {
    _id: 'message-1', clientId: 'client-1', estateId: 'estate-1', tenantId: 'tenant-1',
    g5LinkId: 'link-1', g5LinkVersion: 1, type: 'g5_onboarding_link',
    notificationVersion: 'g5_onboarding_link:v1', idempotencyKey: 'g5:onboard:key',
  };
  const aad = buildProtectedSmsAad({
    messageId: row._id, clientId: row.clientId, estateId: row.estateId, tenantId: row.tenantId,
    linkId: row.g5LinkId, linkVersion: row.g5LinkVersion, type: row.type,
    notificationVersion: row.notificationVersion, idempotencyKey: row.idempotencyKey,
  });
  row.payloadEnvelope = sealEnvelope(JSON.stringify({ phone: '0769563983', body }), aad);
  return row;
}

describe('G5 protected SMS history preview', () => {
  test('shows the exact configured billing SMS, full payment URL and destination number', () => {
    const token = 'A'.repeat(43);
    const row = encryptedRow(`Pendo: Registration confirmed for Po, House 54. Rent: KES 9,000. M-PESA Buy Goods Till 8965322. Submit here: https://pay.example.com/pay#t=${token}`);
    const preview = protectedSmsHistoryPreview(row);
    expect(preview).toContain('Registration confirmed for Po, House 54.');
    expect(preview).toContain('Rent: KES 9,000.');
    expect(preview).toContain('Till 8965322.');
    expect(preview).toContain(`https://pay.example.com/pay#t=${token}`);
    const details = protectedSmsHistoryDetails(row);
    expect(details.phoneNumber).toBe('0769563983');
    expect(details.message).toBe(preview);
  });

  test('fails closed when the protected envelope is missing or cannot authenticate', () => {
    expect(protectedSmsHistoryPreview({})).toBe('Protected message content unavailable.');
    expect(protectedSmsHistoryDetails({})).toEqual({ phoneNumber: '[protected]', message: 'Protected message content unavailable.' });
    const row = encryptedRow('private body');
    row.payloadEnvelope = `${row.payloadEnvelope.slice(0, -2)}xx`;
    expect(protectedSmsHistoryPreview(row)).toBe('Protected message content unavailable.');
  });
});
