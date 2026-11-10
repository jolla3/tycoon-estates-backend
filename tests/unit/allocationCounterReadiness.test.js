import { jest } from '@jest/globals';
import { Payment } from '../../src/models/Payment.js';
import { PaymentAllocation } from '../../src/models/PaymentAllocation.js';
import {
  areAllocationCountersReady,
  _setAllocationCountersReadyForTests,
  verifyAllocationCounters,
} from '../../src/utils/allocationCounterReadiness.js';

function queryResult(rows) {
  return {
    sort() { return this; },
    limit() { return this; },
    select() { return this; },
    async lean() { return rows; },
  };
}

describe('Payment allocation readiness', () => {
  afterEach(() => {
    jest.restoreAllMocks();
    _setAllocationCountersReadyForTests(false);
  });

  test('does not reject a stale allocatedCents compatibility mirror', async () => {
    const payment = {
      _id: '672000000000000000000001',
      clientId: '672000000000000000000002',
      estateId: '672000000000000000000003',
      houseId: '672000000000000000000004',
      tenantId: '672000000000000000000005',
      amountCents: 1_500_000,
      allocatedCents: 1_500_000,
      status: 'CONFIRMED',
    };

    jest.spyOn(Payment, 'find').mockReturnValue(queryResult([payment]));
    jest.spyOn(PaymentAllocation, 'find').mockImplementation((filter = {}) => {
      if (filter.paymentId) return { async lean() { return []; } };
      return queryResult([]);
    });

    const report = await verifyAllocationCounters({ setReady: true });

    expect(report.ok).toBe(true);
    expect(report.checkedPayments).toBe(1);
    expect(report.issues).toEqual([]);
    expect(areAllocationCountersReady()).toBe(true);
  });

  test('still rejects allocations that exceed the confirmed payment amount', async () => {
    const payment = {
      _id: '672000000000000000000011',
      clientId: '672000000000000000000012',
      estateId: '672000000000000000000013',
      houseId: '672000000000000000000014',
      tenantId: '672000000000000000000015',
      amountCents: 100,
      status: 'CONFIRMED',
    };
    const allocation = {
      _id: '672000000000000000000021',
      paymentId: payment._id,
      clientId: payment.clientId,
      estateId: payment.estateId,
      tenancyId: null,
      rentChargeId: '672000000000000000000031',
      amountCents: 200,
    };
    const charge = {
      _id: allocation.rentChargeId,
      clientId: payment.clientId,
      estateId: payment.estateId,
      houseId: payment.houseId,
      tenancyId: null,
    };

    jest.spyOn(Payment, 'find').mockReturnValue(queryResult([payment]));
    jest.spyOn(PaymentAllocation, 'find').mockImplementation((filter = {}) => {
      if (filter.paymentId) return { async lean() { return [allocation]; } };
      return queryResult([]);
    });
    const { RentCharge } = await import('../../src/models/RentCharge.js');
    jest.spyOn(RentCharge, 'findById').mockReturnValue({ async lean() { return charge; } });

    const report = await verifyAllocationCounters({ setReady: true });

    expect(report.ok).toBe(false);
    expect(report.issues).toEqual(expect.arrayContaining([
      expect.objectContaining({ type: 'allocation_sum_exceeds_payment' }),
    ]));
    expect(areAllocationCountersReady()).toBe(false);
  });
});
