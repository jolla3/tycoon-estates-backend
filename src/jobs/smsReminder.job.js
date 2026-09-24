// src/jobs/smsReminder.job.js — section 18/22/25.
//   Find unpaid households -> check SMS history -> send if due -> record.
// A 24h cooldown per house/type prevents duplicate reminders.
import { Estate } from '../models/Estate.js';
import { SmsMessage } from '../models/SmsMessage.js';
import { rentService } from '../services/rent.service.js';
import { smsService } from '../services/sms.service.js';

const REMINDER_COOLDOWN_MS = 24 * 60 * 60 * 1000;

export async function smsReminderJob() {
  const estates = await Estate.find({ isActive: true });

  for (const estate of estates) {
    const unpaid = await rentService.unpaidHouseholds(estate.clientId, estate._id);

    for (const charge of unpaid) {
      const house = charge.houseId;
      const tenant = charge.tenantId;
      if (!tenant?.phone || !house) continue;

      const recentlyReminded = await SmsMessage.findOne({
        clientId: estate.clientId,
        houseId: house._id,
        type: 'rent_reminder',
        createdAt: { $gte: new Date(Date.now() - REMINDER_COOLDOWN_MS) },
      });
      if (recentlyReminded) continue;

      await smsService.sendRentReminder({
        clientId: estate.clientId,
        estateId: estate._id,
        tenantId: tenant._id,
        houseId: house._id,
        phone: tenant.phone,
        tenantName: tenant.name,
        houseNumber: house.houseNumber,
        balanceCents: charge.balanceCents,
      });
    }
  }

  // SMS delivery itself is global, not per-estate — one drain per job run.
  await smsService.processQueuedBatch();
}
