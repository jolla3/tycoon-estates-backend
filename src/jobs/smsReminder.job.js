// Queue one D-5 reminder per active tenancy, billing period and Nairobi due date.
// The saved RentCharge.dueDate is authoritative. Dispatch happens in smsDispatch.job.
import { Estate } from '../models/Estate.js';
import { RentCharge } from '../models/RentCharge.js';
import { Tenancy } from '../models/Tenancy.js';
import { Tenant } from '../models/Tenant.js';
import { House } from '../models/House.js';
import { smsService, previewSms } from '../services/sms.service.js';
import { dateUtil } from '../utils/date.js';
import { aggregateRentCharges, sumOutstandingCents } from '../utils/smsBilling.js';
import { logger } from '../config/logger.js';

export async function smsReminderJob() {
  const targetDay = dateUtil.now().add(5, 'day').format('YYYY-MM-DD');
  const target = dateUtil.parseNairobiDateOnly(targetDay);
  if (!target) throw new Error('Could not resolve Nairobi D-5 calendar date');

  const estates = await Estate.find({ isActive: true })
    .select('_id clientId name currency')
    .lean();
  let queued = 0;
  let skipped = 0;

  for (const estate of estates) {
    const tenancies = await Tenancy.find({
      clientId: estate.clientId,
      estateId: estate._id,
      status: 'ACTIVE',
    }).select('_id tenantId houseId').lean();
    if (!tenancies.length) continue;

    const tenancyById = new Map(tenancies.map((row) => [String(row._id), row]));
    const dueCharges = await RentCharge.find({
      clientId: estate.clientId,
      estateId: estate._id,
      tenancyId: { $in: tenancies.map((row) => row._id) },
      dueDate: { $gte: target.start, $lte: target.end },
      status: { $in: ['UNPAID', 'PARTIAL'] },
      balanceCents: { $gt: 0 },
    }).lean();
    if (!dueCharges.length) continue;

    const grouped = new Map();
    const invalidTenancies = new Set();
    for (const charge of dueCharges) {
      const tenancy = tenancyById.get(String(charge.tenancyId));
      if (!tenancy?.tenantId) continue;

      if (charge.tenantId && String(charge.tenantId) !== String(tenancy.tenantId)) {
        invalidTenancies.add(String(tenancy._id));
        continue;
      }
      if (charge.houseId && tenancy.houseId && String(charge.houseId) !== String(tenancy.houseId)) {
        invalidTenancies.add(String(tenancy._id));
        continue;
      }
      if (!/^[0-9]{4}-(0[1-9]|1[0-2])$/.test(String(charge.period || ''))) {
        invalidTenancies.add(String(tenancy._id));
        continue;
      }

      const dueDateKey = dateUtil.format(charge.dueDate, 'YYYY-MM-DD');
      const key = [
        String(tenancy.tenantId),
        String(tenancy._id),
        charge.period,
        dueDateKey,
      ].join(':');
      if (!grouped.has(key)) {
        grouped.set(key, {
          tenantId: tenancy.tenantId,
          tenancyId: tenancy._id,
          period: charge.period,
          dueDate: charge.dueDate,
          dueDateKey,
          houseIds: new Set(),
          charges: [],
        });
      }
      const group = grouped.get(key);
      group.charges.push(charge);
      if (charge.houseId || tenancy.houseId) {
        group.houseIds.add(String(charge.houseId || tenancy.houseId));
      }
    }

    for (const tenancyId of invalidTenancies) {
      logger.error(
        { estateId: String(estate._id), tenancyId, selectedDate: targetDay },
        'D-5 rent reminder skipped because a charge does not match its tenancy identity'
      );
      skipped += 1;
    }

    const groups = [...grouped.entries()].filter(([, group]) => !invalidTenancies.has(String(group.tenancyId)));
    if (!groups.length) continue;

    const tenantIds = [...new Set(groups.map(([, group]) => String(group.tenantId)))];
    const tenantRows = await Tenant.find({
      clientId: estate.clientId,
      _id: { $in: tenantIds },
    }).select('_id name phone').lean();
    const tenantById = new Map(tenantRows.map((row) => [String(row._id), row]));

    const houseIds = [...new Set(groups.flatMap(([, group]) => [...group.houseIds]))];
    const houseRows = houseIds.length
      ? await House.find({
        clientId: estate.clientId,
        estateId: estate._id,
        _id: { $in: houseIds },
      }).select('_id houseNumber').lean()
      : [];
    const houseById = new Map(houseRows.map((row) => [String(row._id), row]));

    for (const [key, group] of groups) {
      const tenant = tenantById.get(String(group.tenantId));
      if (!tenant?.phone) {
        logger.warn(
          { estateId: String(estate._id), tenantId: String(group.tenantId), tenancyId: String(group.tenancyId), period: group.period },
          'D-5 rent reminder skipped because tenant phone is missing'
        );
        skipped += 1;
        continue;
      }

      try {
        const current = aggregateRentCharges(group.charges);
        const previousRows = await RentCharge.find({
          clientId: estate.clientId,
          estateId: estate._id,
          tenancyId: group.tenancyId,
          period: { $lt: group.period },
          status: { $in: ['UNPAID', 'PARTIAL'] },
          balanceCents: { $gt: 0 },
        }).lean();
        const previousArrearsCents = sumOutstandingCents(previousRows);
        const totalOutstandingCents = current.totalOutstandingCents + previousArrearsCents;
        if (!Number.isSafeInteger(totalOutstandingCents) || totalOutstandingCents <= 0) {
          skipped += 1;
          continue;
        }

        const houseNumbers = [...group.houseIds]
          .map((id) => houseById.get(id)?.houseNumber)
          .filter(Boolean);
        const message = previewSms('rent_reminder_d5', {
          tenantName: tenant.name,
          houseNumber: houseNumbers.join(', ') || 'your registered house',
          period: group.period,
          dueDate: dateUtil.format(group.dueDate, 'DD MMM YYYY'),
          rentOutstandingCents: current.rentOutstandingCents,
          waterOutstandingCents: current.waterOutstandingCents,
          electricityOutstandingCents: current.electricityOutstandingCents,
          otherOutstandingCents: current.otherOutstandingCents,
          previousArrearsCents,
          totalOutstandingCents,
          currency: estate.currency || 'KES',
        });
        const idempotencyKey = [
          'rent-reminder',
          'D5',
          String(estate.clientId),
          String(estate._id),
          String(group.tenantId),
          String(group.tenancyId),
          group.period,
          group.dueDateKey,
          'v2',
        ].join(':');
        const result = await smsService.queueSms({
          clientId: estate.clientId,
          estateId: estate._id,
          tenantId: tenant._id,
          houseId: group.houseIds.size === 1 ? [...group.houseIds][0] : null,
          to: tenant.phone,
          message,
          type: 'rent_reminder',
          priority: 8,
          period: group.period,
          notificationVersion: 'rent_reminder:v2',
          idempotencyKey,
        });
        if (result.created) queued += 1;
        else skipped += 1;
      } catch (err) {
        skipped += 1;
        logger.warn(
          { estateId: String(estate._id), tenantId: String(group.tenantId), tenancyId: String(group.tenancyId), period: group.period, code: err.code || 'REMINDER_DATA_INVALID' },
          'D-5 rent reminder skipped because financial source data was invalid'
        );
      }
    }
  }

  return { selectedDate: targetDay, daysBeforeDue: 5, queued, skipped };
}
