// Explicit index fixture for G3 integration tests.
// This is intentionally limited to a validated disposable test database.
import { BankTransaction } from '../../src/models/BankTransaction.js';
import { DepositMovement } from '../../src/models/DepositMovement.js';
import { Subscription } from '../../src/models/Subscription.js';
import { inspectDepositMovementIndex } from '../../src/utils/depositMovementIndexReadiness.js';
import { HouseType } from '../../src/models/HouseType.js';
import { HouseTypePlanVersion } from '../../src/models/HouseTypePlanVersion.js';
import { Ledger } from '../../src/models/Ledger.js';
import { Payment } from '../../src/models/Payment.js';
import { PaymentAllocation } from '../../src/models/PaymentAllocation.js';
import { RentCharge } from '../../src/models/RentCharge.js';
import { Tenancy } from '../../src/models/Tenancy.js';
import { _setFinancialIndexesReadyForTests } from '../../src/utils/ensureIndexes.js';
import { inspectRentChargeIndexes, _setBillingIndexReportForTests } from '../../src/utils/billingIndexReadiness.js';
import { inspectHouseTypeIndexes } from '../../src/utils/houseTypeIndexReadiness.js';
import { inspectManualPaymentReferenceIndex } from '../../src/utils/manualPaymentIndexReadiness.js';

let preparedConnectionId = null;

export async function prepareG3TestIndexes() {
  const connection = HouseType.db;
  if (!connection?.db || connection.readyState !== 1) {
    throw new Error('prepareG3TestIndexes requires a connected disposable MongoDB database');
  }

  // Build schema-declared operational indexes. Identity indexes below are
  // explicit because production installs them only through guarded migrations.
  await Promise.all([
    Tenancy.createIndexes(),
    RentCharge.createIndexes(),
    Ledger.createIndexes(),
    Payment.createIndexes(),
    PaymentAllocation.createIndexes(),
    BankTransaction.createIndexes(),
    DepositMovement.createIndexes(),
    Subscription.createIndexes(),
  ]);

  await Promise.all([
    HouseType.collection.createIndex(
      { clientId: 1, estateId: 1, name: 1 },
      { name: 'uniq_test_house_type_estate_name_ci', unique: true, collation: { locale: 'en', strength: 2 } }
    ),
    HouseTypePlanVersion.collection.createIndex(
      { houseTypeId: 1, version: 1 },
      { name: 'uniq_test_house_type_version', unique: true }
    ),
    HouseTypePlanVersion.collection.createIndex(
      { houseTypeId: 1, effectiveFromPeriod: 1 },
      { name: 'uniq_test_house_type_effective_period', unique: true }
    ),
    HouseTypePlanVersion.collection.createIndex(
      { clientId: 1, estateId: 1, houseTypeId: 1, effectiveFromPeriod: -1 },
      { name: 'test_house_type_plan_period_resolution' }
    ),
    RentCharge.collection.createIndex(
      { tenancyId: 1, period: 1, chargeType: 1, description: 1 },
      {
        name: 'uniq_tenancy_period_charge_desc',
        unique: true,
        partialFilterExpression: { tenancyId: { $type: 'objectId' } },
      }
    ),
    Payment.collection.createIndex(
      { clientId: 1, origin: 1, paymentReference: 1 },
      {
        name: 'uniq_client_manual_payment_reference',
        unique: true,
        partialFilterExpression: {
          origin: 'MANUAL',
          paymentReference: { $type: 'string', $gt: '' },
        },
      }
    ),
  ]);

  const [billing, houseTypes, manualPayments, depositMovementIndex] = await Promise.all([
    inspectRentChargeIndexes(),
    inspectHouseTypeIndexes(),
    inspectManualPaymentReferenceIndex(),
    inspectDepositMovementIndex(),
  ]);
  if (!billing.aligned || !houseTypes.aligned || !manualPayments.aligned || !depositMovementIndex.aligned) {
    throw new Error(`G3 test indexes failed live readiness checks: ${JSON.stringify({ billing, houseTypes, manualPayments, depositMovementIndex })}`);
  }

  _setBillingIndexReportForTests(billing);
  _setFinancialIndexesReadyForTests(true);
  preparedConnectionId = connection.id;
  return { billing, houseTypes, manualPayments, depositMovementIndex, connectionId: preparedConnectionId };
}
