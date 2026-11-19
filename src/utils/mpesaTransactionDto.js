// Allowlisted projection for canonical M-PESA receipt history.
// Never return posting leases, raw provider payloads or internal retry diagnostics.
const id = (value) => (value == null ? null : String(value));

export function toMpesaTransactionDTO(row) {
  return {
    id: id(row._id),
    merchantProfileId: id(row.merchantProfileId),
    businessShortCode: row.businessShortCode,
    receiptNumber: row.receiptNumber,
    amountCents: row.amountCents,
    currency: row.currency || 'KES',
    transactionAt: row.transactionAt,
    billRefNumber: row.billRefNumber || null,
    transactionType: row.transactionType || null,
    sourceChannels: Array.isArray(row.sourceChannels) ? [...row.sourceChannels] : [],
    verificationState: row.verificationState,
    conflictReason: row.conflictReason || null,
    claimState: row.claimState,
    postingState: row.postingState,
    postedAt: row.postedAt || null,
    attributedEstateId: id(row.attributedEstateId),
    createdAt: row.createdAt,
  };
}
