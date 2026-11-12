import '../setup.js';
import mongoose from 'mongoose';

// Lightweight policy mirror of bank.service connectAccount estate rules
function decideEstateChange({ currentEstateId, targetEstateId, allowEstateReassignment }) {
  if (String(currentEstateId) === String(targetEstateId)) {
    return { action: 'none' };
  }
  if (!allowEstateReassignment) {
    return { action: 'reject', code: 'CONFLICT' };
  }
  return {
    action: 'reassign',
    audit: 'BANK_ACCOUNT_ESTATE_REASSIGNED',
    previousEstateId: currentEstateId,
    newEstateId: targetEstateId,
  };
}

describe('estate reassignment policy', () => {
  const a = new mongoose.Types.ObjectId();
  const b = new mongoose.Types.ObjectId();

  test('same estate reconnect is silent', () => {
    expect(decideEstateChange({
      currentEstateId: a,
      targetEstateId: a,
      allowEstateReassignment: false,
    }).action).toBe('none');
  });

  test('implicit different estate is rejected', () => {
    const r = decideEstateChange({
      currentEstateId: a,
      targetEstateId: b,
      allowEstateReassignment: false,
    });
    expect(r.action).toBe('reject');
  });

  test('explicit reassignment is audited', () => {
    const r = decideEstateChange({
      currentEstateId: a,
      targetEstateId: b,
      allowEstateReassignment: true,
    });
    expect(r.action).toBe('reassign');
    expect(r.audit).toBe('BANK_ACCOUNT_ESTATE_REASSIGNED');
  });
});
