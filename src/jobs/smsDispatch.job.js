// Frequent ordinary SMS outbox draining. Kept independent from billing reminders.
import { smsService } from '../services/sms.service.js';

export async function smsDispatchJob() {
  return smsService.processQueuedBatch(50);
}
