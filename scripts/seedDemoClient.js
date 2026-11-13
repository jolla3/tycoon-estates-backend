/**
 * Idempotent demo/trial property dataset for a Client.
 * Does NOT create bank transactions or claim bank connectivity.
 *
 * Usage:
 *   node scripts/seedDemoClient.js <clientId>
 *
 * Safe to re-run: uses deterministic names/keys and skips existing rows.
 */
import 'dotenv/config';
import mongoose from 'mongoose';
import { Client } from '../src/models/Client.js';
import { Estate } from '../src/models/Estate.js';
import { HouseType } from '../src/models/HouseType.js';
import { House } from '../src/models/House.js';
import { Tenant } from '../src/models/Tenant.js';
import { RentCharge } from '../src/models/RentCharge.js';
import { Payment } from '../src/models/Payment.js';
import { SmsMessage } from '../src/models/SmsMessage.js';
import { Subscription } from '../src/models/Subscription.js';
import { dateUtil } from '../src/utils/date.js';
import { connectDatabase, disconnectDatabase } from '../src/config/database.js';
import { houseTypeService } from '../src/services/houseType.service.js';
import { houseService } from '../src/services/house.service.js';
import { tenantService } from '../src/services/tenant.service.js';
import { tenancyService } from '../src/services/tenancy.service.js';
import { rentService } from '../src/services/rent.service.js';
import { paymentService } from '../src/services/payment.service.js';
import { HouseTypePlanVersion } from '../src/models/HouseTypePlanVersion.js';

const DEMO_TAG = '[Demo]';

async function main() {
  const clientId = process.argv[2];
  if (!clientId || !mongoose.Types.ObjectId.isValid(clientId)) {
    console.error('Usage: node scripts/seedDemoClient.js <clientId>');
    process.exit(1);
  }

  await connectDatabase();
  const client = await Client.findById(clientId);
  if (!client) {
    console.error('Client not found');
    process.exit(1);
  }

  await Subscription.findOneAndUpdate(
    { clientId },
    { $setOnInsert: { clientId, plan: 'trial', status: 'active', startDate: new Date() } },
    { upsert: true }
  );

  let estate = await Estate.findOne({ clientId, name: `${DEMO_TAG} Riverside Estate` });
  if (!estate) {
    estate = await Estate.create({
      clientId,
      name: `${DEMO_TAG} Riverside Estate`,
      address: 'Riverside Drive, Nairobi',
      currency: 'KES',
      defaultDueDay: 5,
      isActive: true,
    });
  }

  const typeSpecs = [
    { name: `${DEMO_TAG} Bedsitter`, rent: 12000, water: 300 },
    { name: `${DEMO_TAG} One Bedroom`, rent: 18000, water: 500 },
    { name: `${DEMO_TAG} Two Bedroom`, rent: 28000, water: 700 },
  ];
  const period = dateUtil.currentPeriod();
  const [periodYear, periodMonth] = period.split('-').map(Number);
  const periodStart = new Date(Date.UTC(periodYear, periodMonth - 1, 1));
  const nextPeriodStart = new Date(Date.UTC(periodYear, periodMonth, 1));
  const types = [];

  for (const spec of typeSpecs) {
    let t = await HouseType.findOne({ clientId, name: spec.name });
    if (!t) {
      t = await houseTypeService.create(clientId, {
        estateId: estate._id,
        name: spec.name,
        description: 'Synthetic demo unit type',
        defaultRentCents: spec.rent * 100,
        defaultDueDay: 5,
        defaultBilling: [
          { chargeType: 'RENT', description: 'Rent', amountCents: spec.rent * 100, dueDay: 5 },
          { chargeType: 'WATER', description: 'Water', amountCents: spec.water * 100, dueDay: 5 },
        ],
        effectiveFromPeriod: period,
      });
    } else if (String(t.estateId || '') !== String(estate._id)) {
      throw new Error(
        `Demo HouseType "${spec.name}" already exists with missing/different Estate ownership. `
        + 'Run the G3.2 legacy classifier and resolve it explicitly; the seeder will not reassign it.'
      );
    }

    const effectivePlan = await HouseTypePlanVersion.findOne({
      clientId, estateId: estate._id, houseTypeId: t._id,
      effectiveFromPeriod: { $lte: period },
    }).sort({ effectiveFromPeriod: -1, version: -1 }).lean();
    if (!effectivePlan) {
      throw new Error(
        `Demo HouseType "${spec.name}" has no effective immutable plan for ${period}. `
        + 'Resolve its plan history before seeding charges.'
      );
    }
    types.push({ ...spec, doc: t });
  }
  const names = ['Amina Kariuki', 'Brian Otieno', 'Carol Wanjiru', 'David Mwangi', 'Esther Njeri', 'Felix Kamau'];
  let houseIdx = 0;
  for (const type of types) {
    for (let i = 0; i < 2; i++) {
      houseIdx += 1;
      const houseNumber = `D${String(houseIdx).padStart(2, '0')}`;
      let house = await House.findOne({ clientId, estateId: estate._id, houseNumber });
      if (!house) {
        house = await houseService.create(clientId, estate._id, {
          houseNumber,
          houseTypeId: type.doc._id,
          monthlyRent: type.rent,
          status: 'occupied',
          isActive: true,
          dueDay: 5,
        });
      } else if (
        String(house.houseTypeId || '') !== String(type.doc._id)
        || house.billingSource !== 'HOUSE_TYPE'
      ) {
        throw new Error(
          `Demo House ${houseNumber} has a legacy or conflicting HouseType/billing source. `
          + 'The seeder will not rewrite existing billing ownership.'
        );
      }

      const tenantName = names[(houseIdx - 1) % names.length];
      let tenant = await Tenant.findOne({ clientId, houseId: house._id, status: 'active' });
      if (!tenant) {
        tenant = await tenantService.create(clientId, {
          houseId: house._id,
          name: `${DEMO_TAG} ${tenantName}`,
          phone: `2547${String(10000000 + houseIdx).slice(0, 8)}`,
          moveInDate: periodStart,
        });
      }

      let tenancy = await tenancyService.getActiveForHouse(clientId, house._id);
      if (tenancy && String(tenancy.tenantId) !== String(tenant._id)) {
        throw new Error(`House ${houseNumber} has an active Tenancy for a different tenant.`);
      }
      if (!tenancy) {
        if (!String(tenant.name || '').startsWith(DEMO_TAG)) {
          throw new Error(
            `Existing non-demo Tenant on ${houseNumber} has no active Tenancy. `
            + 'Resolve occupancy history explicitly instead of manufacturing a record.'
          );
        }
        tenancy = await tenancyService.open({
          clientId, estateId: estate._id, houseId: house._id,
          tenantId: tenant._id, startAt: tenant.moveInDate || periodStart,
        });
      }

      const tenancyCoversPeriod = new Date(tenancy.startAt) <= periodStart
        && (!tenancy.endAt || new Date(tenancy.endAt) >= nextPeriodStart);
      let rentCharge = null;
      if (tenancyCoversPeriod) {
        await rentService.ensureChargesForTenancy(clientId, tenancy, house, period);
        rentCharge = await RentCharge.findOne({
          clientId, estateId: estate._id, houseId: house._id,
          tenancyId: tenancy._id, period, chargeType: 'RENT', description: 'Rent',
        }).lean();
        if (!rentCharge) {
          throw new Error(`G3 charge generation did not produce the expected Rent line for ${houseNumber}/${period}.`);
        }

        if (i === 0) {
          const paymentReference = `DEMO-${houseNumber}-${period}`;
          const payAmount = Math.round(type.rent * 100 * 0.5);
          const existingPayment = await Payment.findOne({ clientId, houseId: house._id, paymentReference }).lean();
          if (existingPayment) {
            if (String(existingPayment.tenancyId || '') !== String(tenancy._id)
              || existingPayment.amountCents !== payAmount
              || existingPayment.origin !== 'MANUAL') {
              throw new Error(
                `Existing demo payment ${paymentReference} has legacy or conflicting attribution. `
                + 'It was not reused or rewritten.'
              );
            }
          } else {
            await paymentService.recordManual(clientId, {
              houseId: house._id,
              tenantId: tenant._id,
              tenancyId: tenancy._id,
              amountCents: payAmount,
              paymentDate: new Date(),
              paymentReference,
              period,
              tenderMethod: 'OTHER',
            }, null, null, {});
          }
        }
      } else {
        console.log(
          `Skipping current-period billing for ${houseNumber}: Tenancy does not cover the full ${period} period.`
        );
      }

      // Sample SMS history — never enter the live Celcom pipeline.
      const smsKey = `demo_sms_${clientId}_${tenant._id}_${period}`;
      const existingSms = await SmsMessage.findOne({ idempotencyKey: smsKey });
      if (!existingSms) {
        await SmsMessage.create({
          clientId,
          estateId: estate._id,
          tenantId: tenant._id,
          houseId: house._id,
          phoneNumber: tenant.phone,
          message: `Demo reminder for ${tenant.name} — House ${houseNumber}`,
          type: 'rent_reminder',
          status: 'cancelled',
          deliveryMode: 'STANDARD',
          dispatchMode: 'SUPPRESSED',
          period,
          idempotencyKey: smsKey,
          failureReason: 'demo_seed_suppressed',
        });
      } else if (existingSms.status === 'queued') {
        // Safe cancel of previously seeded demo rows still waiting to send.
        await SmsMessage.updateOne(
          { _id: existingSms._id, idempotencyKey: smsKey, status: 'queued' },
          { $set: { status: 'cancelled', dispatchMode: 'SUPPRESSED', failureReason: 'demo_seed_suppressed' } }
        );
      }
      // processing/sent/failed/unknown demo rows are left untouched (provider may already be in flight).
    }
  }

  // One vacant house
  const vacantNum = 'D99';
  let vacant = await House.findOne({ clientId, estateId: estate._id, houseNumber: vacantNum });
  if (!vacant) {
    await houseService.create(clientId, estate._id, {
      houseNumber: vacantNum,
      houseTypeId: types[0].doc._id,
      monthlyRent: types[0].rent,
      status: 'vacant',
      isActive: true,
    });
  } else if (
    String(vacant.houseTypeId || '') !== String(types[0].doc._id)
    || vacant.billingSource !== 'HOUSE_TYPE'
  ) {
    throw new Error(`Vacant demo House ${vacantNum} has conflicting billing ownership; refusing to rewrite it.`);
  }

  console.log(JSON.stringify({
    ok: true,
    clientId: String(clientId),
    estateId: String(estate._id),
    period,
    note: 'Bank accounts intentionally not seeded — connect a real bank when ready.',
  }, null, 2));

  await disconnectDatabase();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
