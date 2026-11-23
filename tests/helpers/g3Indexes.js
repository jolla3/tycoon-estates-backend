// Explicit index fixture for G3 integration tests.
// This is intentionally limited to a validated disposable test database.
import { BankTransaction } from '../../src/models/BankTransaction.js';
import { ManualReceipt } from '../../src/models/ManualReceipt.js';
import { MpesaTransaction } from '../../src/models/MpesaTransaction.js';
import { TenantCreditMovement, CREDIT_MOVEMENT_INDEXES } from '../../src/models/TenantCreditMovement.js';
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
import { inspectMpesaIndexes } from '../../src/utils/mpesaIndexReadiness.js';
import { inspectPaymentReceiptReadModelIndexes } from '../../src/utils/paymentReceiptReadModelIndexReadiness.js';

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

  // autoIndex:false models and read-model gates are prepared explicitly here,
  // only for the already validated disposable replica-set database.
  await Promise.all([
    TenantCreditMovement.collection.createIndex(
      CREDIT_MOVEMENT_INDEXES.IDEMPOTENCY.key,
      { name: CREDIT_MOVEMENT_INDEXES.IDEMPOTENCY.name, unique: true }
    ),
    ManualReceipt.collection.createIndex(
      { clientId: 1, estateId: 1, paymentDate: -1 },
      { name: 'clientId_1_estateId_1_paymentDate_-1' }
    ),
    MpesaTransaction.collection.createIndex(
      { verificationState: 1, transactionAt: -1 },
      { name: 'idx_mpesa_txn_verification' }
    ),
    MpesaTransaction.collection.createIndex(
      { clientId: 1, transactionAt: -1 },
      { name: 'idx_mpesa_txn_client_time' }
    ),
    MpesaTransaction.collection.createIndex(
      { attributedClientId: 1, attributedEstateId: 1, postingState: 1, transactionAt: -1 },
      { name: 'idx_mpesa_attributed_posted_receipts' }
    ),
    TenantCreditMovement.collection.createIndex(
      { clientId: 1, estateId: 1, tenantId: 1, createdAt: 1 },
      { name: 'clientId_1_estateId_1_tenantId_1_createdAt_1' }
    ),
    TenantCreditMovement.collection.createIndex(
      { mpesaTransactionId: 1 },
      { name: 'idx_tenant_credit_mpesa_receipt', partialFilterExpression: { mpesaTransactionId: { $type: 'objectId' } } }
    ),
    TenantCreditMovement.collection.createIndex(
      { manualReceiptId: 1 },
      { name: 'idx_tenant_credit_manual_receipt', partialFilterExpression: { manualReceiptId: { $type: 'objectId' } } }
    ),
    TenantCreditMovement.collection.createIndex(
      { bankTransactionId: 1 },
      { name: 'idx_tenant_credit_bank_receipt', partialFilterExpression: { bankTransactionId: { $type: 'objectId' } } }
    ),
  ]);

  const [billing, houseTypes, manualPayments, depositMovementIndex, receiptReadModelIndexes, mpesaIndexes] = await Promise.all([
    inspectRentChargeIndexes(),
    inspectHouseTypeIndexes(),
    inspectManualPaymentReferenceIndex(),
    inspectDepositMovementIndex(),
    inspectPaymentReceiptReadModelIndexes(),
    inspectMpesaIndexes(),
  ]);
  if (!billing.aligned || !houseTypes.aligned || !manualPayments.aligned || !depositMovementIndex.aligned
    || !receiptReadModelIndexes.aligned || mpesaIndexes?.gates?.canonicalQueryIndexes !== true) {
    throw new Error(`G3 test indexes failed live readiness checks: ${JSON.stringify({ billing, houseTypes, manualPayments, depositMovementIndex, receiptReadModelIndexes, mpesaIndexes })}`);
  }

  _setBillingIndexReportForTests(billing);
  _setFinancialIndexesReadyForTests(true);
  preparedConnectionId = connection.id;
  return { billing, houseTypes, manualPayments, depositMovementIndex, receiptReadModelIndexes, mpesaIndexes, connectionId: preparedConnectionId };
}
