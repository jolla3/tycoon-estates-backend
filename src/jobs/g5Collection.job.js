// G5 collection background work. Every step is individually fail-closed by env/gates and
// safe under multiple workers (conditional claims, fenced leases); the scheduler lock only
// reduces duplicate effort.
import { env } from '../config/environment.js';
import { matchPendingSubmissions } from '../services/mpesa/mpesaSubmission.service.js';
import { dispatchProtectedBatch } from '../services/g5ProtectedSms.service.js';

export async function g5CollectionJob() {
  if (env.G5_SUBMISSIONS_ENABLED === '1') await matchPendingSubmissions(50);
  await dispatchProtectedBatch(20); // no-op when no protected rows exist
}
