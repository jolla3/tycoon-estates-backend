// The canonical receipt identity gate is a hard blocker, not a readiness probe: even a database
// that carries every candidate receipt index must not unlock posting, because provider evidence
// of receipt-number uniqueness scope (B01/B02) does not exist yet.
import '../../setup.js';
import { jest } from '@jest/globals';
import mongoose from 'mongoose';

const { inspectMpesaIndexes, REFERENCE_UNIQUE_INDEXES, MERCHANT_UNIQUE_INDEX, PROFILE_ESTATE_UNIQUE_INDEX, CHECKPOINT_UNIQUE_INDEX, REQUIRED_OPERATIONAL_INDEXES } =
  await import('../../../src/utils/mpesaIndexReadiness.js');

const idx = (s) => ({ key: s.key, name: s.name, unique: Boolean(s.unique), ...(s.partialFilterExpression ? { partialFilterExpression: s.partialFilterExpression } : {}) });

test('every candidate receipt index present => canonicalReceiptIdentity is still false', async () => {
  const all = [
    ...REQUIRED_OPERATIONAL_INDEXES, MERCHANT_UNIQUE_INDEX, PROFILE_ESTATE_UNIQUE_INDEX, CHECKPOINT_UNIQUE_INDEX, ...REFERENCE_UNIQUE_INDEXES,
  ];
  const candidates = [
    { collection: 'mpesatransactions', key: { provider: 1, businessShortCode: 1, receiptNumber: 1 }, name: 'uniq_provider_shortcode_receipt', unique: true },
    { collection: 'mpesatransactions', key: { merchantProfileId: 1, receiptNumber: 1 }, name: 'uniq_mpesa_txn_profile_receipt', unique: true },
  ];
  const byCollection = {};
  for (const s of [...all, ...candidates]) (byCollection[s.collection] ||= []).push(idx(s));
  jest.spyOn(mongoose, 'connection', 'get').mockReturnValue({ db: { collection: (n) => ({ indexes: async () => byCollection[n] || [] }) } });
  const report = await inspectMpesaIndexes();
  expect(report.gates.collectionReferences).toBe(true);
  expect(report.gates.profileEstateMapping).toBe(true);
  expect(report.gates.canonicalReceiptIdentity).toBe(false);
});
