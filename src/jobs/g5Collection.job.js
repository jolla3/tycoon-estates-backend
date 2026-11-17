// G5 collection background work. Every step is individually fail-closed by env/gates and
// safe under multiple workers (conditional claims, fenced leases); the scheduler lock only
// reduces duplicate effort.
import { env } from '../config/environment.js';
import { matchPendingSubmissions } from '../services/mpesa/mpesaSubmission.service.js';
import { dispatchProtectedBatch } from '../services/g5ProtectedSms.service.js';

export async function g5CollectionJob() {
  const submissionsOn = env.G5_SUBMISSIONS_ENABLED === '1';
  const smsOn = env.G5_PROTECTED_SMS_ENABLED === '1';
  if (!submissionsOn && !smsOn) return { ran: false, reason: 'g5_features_disabled' };
  const matched = submissionsOn ? await matchPendingSubmissions(50) : 0;
  const dispatched = smsOn ? await dispatchProtectedBatch(20) : 0;
  return { attempted: matched + dispatched, successful: matched + dispatched, failed: 0, blocked: 0, skipped: 0 };
}
