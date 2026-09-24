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
import { env } from '../src/config/environment.js';
import { Client } from '../src/models/Client.js';
import { Estate } from '../src/models/Estate.js';
import { HouseType } from '../src/models/HouseType.js';
import { House } from '../src/models/House.js';
import { Tenant } from '../src/models/Tenant.js';
import { RentCharge } from '../src/models/RentCharge.js';
import { Payment } from '../src/models/Payment.js';
import { PaymentAllocation } from '../src/models/PaymentAllocation.js';
import { SmsMessage } from '../src/models/SmsMessage.js';
import { Subscription } from '../src/models/Subscription.js';
import { ledgerService } from '../src/services/ledger.service.js';
import { dateUtil } from '../src/utils/date.js';

const DEMO_TAG = '[Demo]';

async function main() {
  const clientId = process.argv[2];
  if (!clientId || !mongoose.Types.ObjectId.isValid(clientId)) {
    console.error('Usage: node scripts/seedDemoClient.js <clientId>');
    process.exit(1);
  }

  await mongoose.connect(env.MONGODB_URI);
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
  const types = [];
  for (const spec of typeSpecs) {
    let t = await HouseType.findOne({ clientId, name: spec.name });
    if (!t) {
      t = await HouseType.create({
        clientId,
        name: spec.name,
        description: 'Synthetic demo unit type',
        defaultRentCents: spec.rent * 100,
        defaultDueDay: 5,
        defaultBilling: [
          { chargeType: 'RENT', description: 'Rent', amountCents: spec.rent * 100, dueDay: 5 },
          { chargeType: 'WATER', description: 'Water', amountCents: spec.water * 100, dueDay: 5 },
        ],
        isActive: true,
      });
    }
    types.push({ ...spec, doc: t });
  }

  const period = dateUtil.currentPeriod();
  const names = ['Amina Kariuki', 'Brian Otieno', 'Carol Wanjiru', 'David Mwangi', 'Esther Njeri', 'Felix Kamau'];
  let houseIdx = 0;
  for (const type of types) {
    for (let i = 0; i < 2; i++) {
      houseIdx += 1;
      const houseNumber = `D${String(houseIdx).padStart(2, '0')}`;
      let house = await House.findOne({ clientId, estateId: estate._id, houseNumber });
      if (!house) {
        house = await House.create({
          clientId,
          estateId: estate._id,
          houseNumber,
          houseTypeId: type.doc._id,
          monthlyRent: type.rent,
          status: 'occupied',
          isActive: true,
          dueDay: 5,
        });
      }
      const tenantName = names[(houseIdx - 1) % names.length];
      let tenant = await Tenant.findOne({ clientId, houseId: house._id, status: 'active' });
      if (!tenant) {
        tenant = await Tenant.create({
          clientId,
          estateId: estate._id,
          houseId: house._id,
          name: `${DEMO_TAG} ${tenantName}`,
          phone: `2547${String(10000000 + houseIdx).slice(0, 8)}`,
          status: 'active',
          moveInDate: new Date(),
        });
        house.tenantId = tenant._id;
        house.status = 'occupied';
        await house.save();
      }

      for (const line of [
        { chargeType: 'RENT', amount: type.rent * 100 },
        { chargeType: 'WATER', amount: type.water * 100 },
      ]) {
        let charge = await RentCharge.findOne({
          clientId,
          houseId: house._id,
          period,
          chargeType: line.chargeType,
        });
        if (!charge) {
          charge = await RentCharge.create({
            clientId,
            estateId: estate._id,
            houseId: house._id,
            tenantId: tenant._id,
            period,
            chargeType: line.chargeType,
            description: line.chargeType,
            amountDueCents: line.amount,
            amountPaidCents: 0,
            balanceCents: line.amount,
            status: 'UNPAID',
            dueDate: dateUtil.dueDateFor(period, 5),
          });
          try {
            await ledgerService.postEntry({
              clientId,
              estateId: estate._id,
              houseId: house._id,
              tenantId: tenant._id,
              entryType: 'CHARGE',
              amountCents: -line.amount,
              referenceType: 'RentCharge',
              referenceId: charge._id,
              description: `${line.chargeType} ${period}`,
              period,
            });
          } catch {
            /* idempotent */
          }
        }
      }

      // Partial payment on first unit of each type
      if (i === 0) {
        const existingPay = await Payment.findOne({
          clientId,
          houseId: house._id,
          paymentReference: `DEMO-${houseNumber}-${period}`,
        });
        if (!existingPay) {
          const payAmount = Math.round(type.rent * 100 * 0.5);
          const [payment] = await Payment.create([
            {
              clientId,
              estateId: estate._id,
              houseId: house._id,
              tenantId: tenant._id,
              amountCents: payAmount,
              paymentDate: new Date(),
              paymentReference: `DEMO-${houseNumber}-${period}`,
              period,
              status: 'CONFIRMED',
            },
          ]);
          const rentCharge = await RentCharge.findOne({
            clientId,
            houseId: house._id,
            period,
            chargeType: 'RENT',
          });
          if (rentCharge) {
            rentCharge.amountPaidCents = Math.min(rentCharge.amountDueCents, (rentCharge.amountPaidCents || 0) + payAmount);
            rentCharge.balanceCents = Math.max(0, rentCharge.amountDueCents - rentCharge.amountPaidCents);
            rentCharge.status = rentCharge.balanceCents === 0 ? 'PAID' : 'PARTIAL';
            await rentCharge.save();
            await PaymentAllocation.create({
              clientId,
              estateId: estate._id,
              paymentId: payment._id,
              rentChargeId: rentCharge._id,
              amountCents: payAmount,
              chargeType: 'RENT',
              period,
            });
          }
          try {
            await ledgerService.postEntry({
              clientId,
              estateId: estate._id,
              houseId: house._id,
              tenantId: tenant._id,
              entryType: 'PAYMENT',
              amountCents: payAmount,
              referenceType: 'Payment',
              referenceId: payment._id,
              description: `Demo payment ${payment.paymentReference}`,
              period,
            });
          } catch {
            /* idempotent */
          }
        }
      }

      // Sample SMS history (not sent)
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
          status: 'queued',
          period,
          idempotencyKey: smsKey,
        });
      }
    }
  }

  // One vacant house
  const vacantNum = 'D99';
  let vacant = await House.findOne({ clientId, estateId: estate._id, houseNumber: vacantNum });
  if (!vacant) {
    await House.create({
      clientId,
      estateId: estate._id,
      houseNumber: vacantNum,
      houseTypeId: types[0].doc._id,
      monthlyRent: types[0].rent,
      status: 'vacant',
      isActive: true,
    });
  }

  console.log(JSON.stringify({
    ok: true,
    clientId: String(clientId),
    estateId: String(estate._id),
    period,
    note: 'Bank accounts intentionally not seeded — connect a real bank when ready.',
  }, null, 2));

  await mongoose.disconnect();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
