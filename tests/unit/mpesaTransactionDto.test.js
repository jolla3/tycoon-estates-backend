import { toMpesaTransactionDTO } from '../../src/utils/mpesaTransactionDto.js';

describe('toMpesaTransactionDTO', () => {
  test('returns canonical receipt history fields only', () => {
    const row = {
      _id: 'receipt-id', merchantProfileId: 'profile-id', businessShortCode: '123456',
      receiptNumber: 'ABC123', amountCents: 12500, currency: 'KES',
      transactionAt: new Date('2026-11-19T07:00:00.000Z'), billRefNumber: 'HOUSE-1',
      transactionType: 'CustomerBuyGoodsOnline', sourceChannels: ['C2B_CONFIRMATION'],
      verificationState: 'MATCHED', conflictReason: null, claimState: 'UNCLAIMED',
      postingState: 'NOT_POSTED', postedAt: null, attributedEstateId: null,
      attributedTenancyId: 'source-tenancy-id', createdAt: new Date(),
      postingLeaseToken: 'SECRET-LEASE', postingLeaseExpiresAt: new Date(),
      postingFailureCode: 'INTERNAL', rawPayload: { password: 'DO_NOT_RETURN' },
    };
    const dto = toMpesaTransactionDTO(row);
    expect(dto).toMatchObject({
      id: 'receipt-id', merchantProfileId: 'profile-id', receiptNumber: 'ABC123',
      amountCents: 12500, verificationState: 'MATCHED', postingState: 'NOT_POSTED',
      attributedTenancyId: 'source-tenancy-id',
    });
    for (const key of ['postingLeaseToken', 'postingLeaseExpiresAt', 'postingFailureCode', 'rawPayload']) {
      expect(dto).not.toHaveProperty(key);
    }
  });

  test('normalizes optional fields', () => {
    const dto = toMpesaTransactionDTO({
      _id: 'id', businessShortCode: '123', receiptNumber: 'R1', amountCents: 10,
      transactionAt: new Date(), verificationState: 'UNVERIFIED', claimState: 'UNCLAIMED',
      postingState: 'NOT_POSTED',
    });
    expect(dto.billRefNumber).toBeNull();
    expect(dto.sourceChannels).toEqual([]);
    expect(dto.attributedEstateId).toBeNull();
    expect(dto.attributedTenancyId).toBeNull();
  });
});
