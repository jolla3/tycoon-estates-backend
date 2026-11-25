import '../../setup.js';
import { jest } from '@jest/globals';
import mongoose from 'mongoose';

const findOne = jest.fn();
const audit = jest.fn();
const auditRequired = jest.fn();
const matchSubmission = jest.fn();

jest.unstable_mockModule('../../../src/models/MpesaSmsSubmission.js', () => ({
  MpesaSmsSubmission: { findOne },
  SUBMISSION_STATE: {
    UNSUPPORTED: 'UNSUPPORTED',
    UNMATCHED: 'UNMATCHED',
    CONFLICTING: 'CONFLICTING',
    MANUAL_REVIEW: 'MANUAL_REVIEW',
    POSTED: 'POSTED',
    PARSED: 'PARSED',
  },
}));
jest.unstable_mockModule('../../../src/services/audit.service.js', () => ({ audit, auditRequired }));
jest.unstable_mockModule('../../../src/services/mpesa/mpesaSubmission.service.js', () => ({ matchSubmission }));

const { sealEnvelope } = await import('../../../src/utils/g5Envelope.js');
const { mpesaSubmissionReviewService: service } = await import('../../../src/services/mpesa/mpesaSubmissionReview.service.js');

const CLIENT = new mongoose.Types.ObjectId();
const ESTATE = new mongoose.Types.ObjectId();
const ID = new mongoose.Types.ObjectId();
const MESSAGE = 'QWERTY1234 Confirmed. Ksh1,250.00 paid to Example Shop. on 25/11/26 at 01:40 PM New M-PESA balance is Ksh2,000.00. Transaction cost, Ksh0.00';

function queryFor(row) {
  return {
    select: jest.fn().mockReturnThis(),
    lean: jest.fn().mockResolvedValue(row),
  };
}

beforeEach(() => {
  findOne.mockReset();
  audit.mockReset();
  auditRequired.mockReset().mockResolvedValue(undefined);
  matchSubmission.mockReset();
  process.env.G5_ENVELOPE_KEYS = `v1:${'11'.repeat(32)}`;
});

afterAll(() => {
  delete process.env.G5_ENVELOPE_KEYS;
});

describe('M-PESA submission evidence detail', () => {
  test('decrypts only a client/estate-scoped retained envelope and records a safe required audit', async () => {
    const envelope = sealEnvelope(MESSAGE, `g5sub:${ID}:${CLIENT}`);
    findOne.mockReturnValue(queryFor({
      _id: ID,
      clientId: CLIENT,
      estateId: ESTATE,
      state: 'UNSUPPORTED',
      stateReason: 'unsupported_template',
      parserVersion: 'mpesa-sms-parser/1',
      template: null,
      parseErrors: ['unsupported_template'],
      createdAt: new Date('2026-11-25T13:40:40.699Z'),
      retentionState: 'RETAINED_ENCRYPTED',
      evidenceEnvelope: envelope,
    }));

    const out = await service.evidence({
      clientId: CLIENT,
      estateFilter: [String(ESTATE)],
      id: String(ID),
      actor: { userId: 'reviewer-1', ip: '127.0.0.1', userAgent: 'test-agent' },
    });

    expect(findOne).toHaveBeenCalledWith({
      _id: String(ID),
      clientId: CLIENT,
      estateId: { $in: [String(ESTATE)] },
    });
    expect(findOne.mock.results[0].value.select).toHaveBeenCalledWith(
      expect.stringContaining('+evidenceEnvelope')
    );
    expect(out).toMatchObject({
      id: String(ID),
      available: true,
      unavailableReason: null,
      message: MESSAGE,
      state: 'UNSUPPORTED',
      stateReason: 'unsupported_template',
      parserVersion: 'mpesa-sms-parser/1',
      parseErrors: ['unsupported_template'],
    });
    expect(out).not.toHaveProperty('evidenceEnvelope');
    expect(auditRequired).toHaveBeenCalledWith(expect.objectContaining({
      clientId: CLIENT,
      estateId: ESTATE,
      userId: 'reviewer-1',
      action: 'G5_SUBMISSION_EVIDENCE_VIEWED',
      resource: 'MpesaSmsSubmission',
      resourceId: String(ID),
      metadata: {
        available: true,
        unavailableReason: null,
        state: 'UNSUPPORTED',
        parserVersion: 'mpesa-sms-parser/1',
        retentionState: 'RETAINED_ENCRYPTED',
      },
    }));
    expect(JSON.stringify(auditRequired.mock.calls)).not.toContain(MESSAGE);
    expect(JSON.stringify(auditRequired.mock.calls)).not.toContain(envelope);
  });

  test('does not disclose a submission outside the client or estate scope', async () => {
    findOne.mockReturnValue(queryFor(null));
    await expect(service.evidence({
      clientId: CLIENT,
      estateFilter: [String(ESTATE)],
      id: String(ID),
      actor: { userId: 'reviewer-1' },
    })).rejects.toMatchObject({ status: 404, code: 'NOT_FOUND' });
    expect(auditRequired).not.toHaveBeenCalled();
  });

  test('reports evidence that was not retained without pretending a digest can recover it', async () => {
    findOne.mockReturnValue(queryFor({
      _id: ID,
      clientId: CLIENT,
      estateId: ESTATE,
      state: 'UNSUPPORTED',
      stateReason: 'unsupported_template',
      parserVersion: 'mpesa-sms-parser/1',
      parseErrors: ['unsupported_template'],
      retentionState: 'NOT_RETAINED_POLICY_PENDING',
      evidenceEnvelope: null,
    }));
    const out = await service.evidence({ clientId: CLIENT, estateFilter: null, id: String(ID), actor: { userId: 'reviewer-1' } });
    expect(out).toMatchObject({ available: false, unavailableReason: 'NOT_RETAINED', message: null });
    expect(auditRequired).toHaveBeenCalledWith(expect.objectContaining({
      metadata: expect.objectContaining({ available: false, unavailableReason: 'NOT_RETAINED' }),
    }));
  });

  test('fails closed when the required evidence-view audit cannot be written', async () => {
    const envelope = sealEnvelope(MESSAGE, `g5sub:${ID}:${CLIENT}`);
    findOne.mockReturnValue(queryFor({
      _id: ID, clientId: CLIENT, estateId: ESTATE, state: 'UNSUPPORTED',
      parserVersion: 'mpesa-sms-parser/1', parseErrors: [],
      retentionState: 'RETAINED_ENCRYPTED', evidenceEnvelope: envelope,
    }));
    auditRequired.mockRejectedValue(new Error('audit storage unavailable'));
    await expect(service.evidence({
      clientId: CLIENT, estateFilter: null, id: String(ID), actor: { userId: 'reviewer-1' },
    })).rejects.toThrow('audit storage unavailable');
  });

  test('fails closed for a corrupt or wrong-key envelope without logging or returning ciphertext', async () => {
    const envelope = sealEnvelope(MESSAGE, `g5sub:${ID}:${CLIENT}`);
    process.env.G5_ENVELOPE_KEYS = `v1:${'22'.repeat(32)}`;
    findOne.mockReturnValue(queryFor({
      _id: ID, clientId: CLIENT, estateId: ESTATE, state: 'UNSUPPORTED',
      parserVersion: 'mpesa-sms-parser/1', parseErrors: [],
      retentionState: 'RETAINED_ENCRYPTED', evidenceEnvelope: envelope,
    }));
    await expect(service.evidence({
      clientId: CLIENT, estateFilter: null, id: String(ID), actor: { userId: 'reviewer-1' },
    })).rejects.toMatchObject({ status: 503, code: 'SERVICE_UNAVAILABLE' });
    expect(auditRequired).not.toHaveBeenCalled();
  });
});
